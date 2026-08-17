import { test } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { authorizeDetection } from "../src/index";

const fn = authorizeDetection as unknown as {
  run: (request: { auth?: { uid: string }; data: unknown }) => Promise<{ authorized: boolean }>;
};

function seedOwner(deviceId: string, ownerUserId: string) {
  return getFirestore().collection("devices").doc(deviceId).set({ ownerUserId });
}

function seedPremium(deviceId: string, premium: boolean) {
  return getFirestore().collection("subscriptions").doc(deviceId).set({ premium });
}

function seedPairing(pairingId: string, memberDeviceIds: string[]) {
  return getFirestore()
    .collection("pairings")
    .doc(pairingId)
    .set({ memberDeviceIds, status: "active" });
}

async function expectRejection(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, code);
    return true;
  });
}

test("an unauthenticated caller is rejected", async () => {
  await expectRejection(
    fn.run({ data: { cameraDeviceId: "cam-1", authorizerDeviceId: "cam-1" } }),
    "unauthenticated"
  );
});

test("a caller that does not own the authorizer device is rejected", async () => {
  await seedOwner("auth-owned-by-other", "someone-else");
  await seedPremium("auth-owned-by-other", true);
  await expectRejection(
    fn.run({
      auth: { uid: "caller-uid" },
      data: { cameraDeviceId: "auth-owned-by-other", authorizerDeviceId: "auth-owned-by-other" },
    }),
    "permission-denied"
  );
});

test("a caller whose authorizer device lacks premium is rejected", async () => {
  await seedOwner("auth-free", "owner-free");
  await seedPremium("auth-free", false);
  await expectRejection(
    fn.run({
      auth: { uid: "owner-free" },
      data: { cameraDeviceId: "auth-free", authorizerDeviceId: "auth-free" },
    }),
    "failed-precondition"
  );
});

test("a premium authorizer that is not paired with a different camera is rejected", async () => {
  await seedOwner("auth-unpaired", "owner-unpaired");
  await seedPremium("auth-unpaired", true);
  await expectRejection(
    fn.run({
      auth: { uid: "owner-unpaired" },
      data: { cameraDeviceId: "cam-unpaired", authorizerDeviceId: "auth-unpaired" },
    }),
    "permission-denied"
  );
});

test("an owner with premium authorizes its own camera and the device identity is recorded", async () => {
  await seedOwner("cam-self", "owner-self");
  await seedPremium("cam-self", true);
  const result = await fn.run({
    auth: { uid: "owner-self" },
    data: { cameraDeviceId: "cam-self", authorizerDeviceId: "cam-self" },
  });
  assert.equal(result.authorized, true);
  const settings = await getFirestore().collection("detectionSettings").doc("cam-self").get();
  assert.equal(settings.get("detectionAuthorizedBy"), "cam-self");
  assert.ok(settings.get("detectionAuthorizedAt"));
});

test("a premium viewer paired with a free camera authorizes it, recording the viewer identity", async () => {
  await seedOwner("viewer-premium", "owner-viewer");
  await seedPremium("viewer-premium", true);
  await seedPairing("pair-1", ["viewer-premium", "free-camera"]);
  const result = await fn.run({
    auth: { uid: "owner-viewer" },
    data: { cameraDeviceId: "free-camera", authorizerDeviceId: "viewer-premium" },
  });
  assert.equal(result.authorized, true);
  const settings = await getFirestore().collection("detectionSettings").doc("free-camera").get();
  assert.equal(settings.get("detectionAuthorizedBy"), "viewer-premium");
});

test("a null authorizer clears the recorded authorization", async () => {
  await getFirestore()
    .collection("detectionSettings")
    .doc("cam-revoke")
    .set({ detectionAuthorizedBy: "cam-revoke", motionDetectionEnabled: true });
  const result = await fn.run({
    auth: { uid: "owner-revoke" },
    data: { cameraDeviceId: "cam-revoke", authorizerDeviceId: null },
  });
  assert.equal(result.authorized, false);
  const settings = await getFirestore().collection("detectionSettings").doc("cam-revoke").get();
  assert.equal(settings.get("detectionAuthorizedBy"), undefined);
  assert.equal(settings.get("motionDetectionEnabled"), true);
});
