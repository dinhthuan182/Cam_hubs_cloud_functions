import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import { pairWithToken, syncHostedCameraEditors } from "../src/index";
import { mirrorEditorsToHostedCameras, pairingIdFor, recomputeEditors } from "../src/pairing";
import { ownersNeedingPremiumSync, syncOwnerPremium } from "../src/userPremium";

const fn = pairWithToken as unknown as {
  run: (request: { auth?: { uid: string }; data: unknown }) => Promise<{
    pairingId: string;
    device: Record<string, unknown>;
  }>;
};

function uniq(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

async function seedDevice(id: string, ownerUserId: string, extra: Record<string, unknown> = {}) {
  await getFirestore()
    .collection("devices")
    .doc(id)
    .set({ ownerUserId, displayName: id, platform: "iPad", isStreaming: true, pairingToken: uniq("tok"), ...extra });
}

async function deviceField(id: string, field: string) {
  return (await getFirestore().collection("devices").doc(id).get()).get(field);
}

async function expectRejection(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, code);
    return true;
  });
}

test("pairWithToken rejects unauthenticated callers and missing arguments", async () => {
  await expectRejection(fn.run({ data: { deviceId: "a", pairingToken: "b" } }), "unauthenticated");
  await expectRejection(fn.run({ auth: { uid: "u" }, data: { deviceId: "a" } }), "invalid-argument");
  await expectRejection(fn.run({ auth: { uid: "u" }, data: { pairingToken: "b" } }), "invalid-argument");
});

test("pairWithToken rejects an unknown or rotated token", async () => {
  const viewer = uniq("viewer");
  const camera = uniq("camera");
  const token = uniq("tok");
  await seedDevice(viewer, "viewer-owner");
  await seedDevice(camera, "camera-owner", { pairingToken: token });
  await expectRejection(
    fn.run({ auth: { uid: "viewer-owner" }, data: { deviceId: viewer, pairingToken: uniq("missing") } }),
    "not-found"
  );
  await getFirestore().collection("devices").doc(camera).update({ pairingToken: uniq("rotated") });
  await expectRejection(
    fn.run({ auth: { uid: "viewer-owner" }, data: { deviceId: viewer, pairingToken: token } }),
    "not-found"
  );
});

test("pairWithToken rejects a caller that does not own the local device", async () => {
  const viewer = uniq("viewer");
  const camera = uniq("camera");
  const token = uniq("tok");
  await seedDevice(viewer, "real-owner");
  await seedDevice(camera, "camera-owner", { pairingToken: token });
  await expectRejection(
    fn.run({ auth: { uid: "impostor" }, data: { deviceId: viewer, pairingToken: token } }),
    "permission-denied"
  );
  const pairing = await getFirestore().collection("pairings").doc(pairingIdFor(viewer, camera)).get();
  assert.equal(pairing.exists, false);
});

test("pairWithToken rejects pairing a device with itself", async () => {
  const device = uniq("self");
  const token = uniq("tok");
  await seedDevice(device, "self-owner", { pairingToken: token });
  await expectRejection(
    fn.run({ auth: { uid: "self-owner" }, data: { deviceId: device, pairingToken: token } }),
    "invalid-argument"
  );
});

test("pairWithToken creates the pairing, grants both owners access and is idempotent", async () => {
  const viewer = uniq("viewer");
  const camera = uniq("camera");
  const token = uniq("tok");
  await seedDevice(viewer, "owner-v");
  await seedDevice(camera, "owner-c", { pairingToken: token, displayName: "Nursery" });

  const first = await fn.run({ auth: { uid: "owner-v" }, data: { deviceId: viewer, pairingToken: token } });
  const second = await fn.run({ auth: { uid: "owner-v" }, data: { deviceId: viewer, pairingToken: token } });

  assert.equal(first.pairingId, pairingIdFor(viewer, camera));
  assert.equal(second.pairingId, first.pairingId);
  assert.deepEqual(first.device, {
    id: camera,
    ownerUserId: "owner-c",
    displayName: "Nursery",
    platform: "iPad",
    isStreaming: true,
  });
  const pairing = await getFirestore().collection("pairings").doc(first.pairingId).get();
  const sorted = [viewer, camera].sort();
  assert.equal(pairing.get("status"), "active");
  assert.deepEqual(pairing.get("memberDeviceIds"), sorted);
  assert.equal(pairing.get("deviceA"), sorted[0]);
  assert.equal(pairing.get("deviceB"), sorted[1]);
  assert.deepEqual(await deviceField(camera, "editorUserIds"), ["owner-v"]);
  assert.deepEqual(await deviceField(viewer, "editorUserIds"), ["owner-c"]);
});

test("pairWithToken re-activates a removed pairing", async () => {
  const viewer = uniq("viewer");
  const camera = uniq("camera");
  const token = uniq("tok");
  await seedDevice(viewer, "owner-rv");
  await seedDevice(camera, "owner-rc", { pairingToken: token });
  const { pairingId } = await fn.run({ auth: { uid: "owner-rv" }, data: { deviceId: viewer, pairingToken: token } });
  await getFirestore().collection("pairings").doc(pairingId).update({ status: "removed" });

  await fn.run({ auth: { uid: "owner-rv" }, data: { deviceId: viewer, pairingToken: token } });

  const pairing = await getFirestore().collection("pairings").doc(pairingId).get();
  assert.equal(pairing.get("status"), "active");
});

test("recomputeEditors keeps only owners of actively paired peers", async () => {
  const camera = uniq("camera");
  const viewerA = uniq("viewer-a");
  const viewerB = uniq("viewer-b");
  const viewerC = uniq("viewer-c");
  await seedDevice(camera, "owner-cam", { editorUserIds: ["owner-a", "owner-b", "stale-uid"] });
  await seedDevice(viewerA, "owner-a");
  await seedDevice(viewerB, "owner-b");
  await seedDevice(viewerC, "owner-a");
  const pairings = getFirestore().collection("pairings");
  await pairings.doc(pairingIdFor(camera, viewerA)).set({ memberDeviceIds: [camera, viewerA], status: "removed" });
  await pairings.doc(pairingIdFor(camera, viewerB)).set({ memberDeviceIds: [camera, viewerB], status: "removed" });
  await pairings.doc(pairingIdFor(camera, viewerC)).set({ memberDeviceIds: [camera, viewerC], status: "active" });

  const editors = await recomputeEditors(getFirestore(), camera);

  assert.deepEqual(editors, ["owner-a"]);
  assert.deepEqual(await deviceField(camera, "editorUserIds"), ["owner-a"]);
});

test("recomputeEditors clears editors when no pairing is active and skips missing devices", async () => {
  const camera = uniq("camera");
  await seedDevice(camera, "owner-solo", { editorUserIds: ["gone"] });
  assert.deepEqual(await recomputeEditors(getFirestore(), camera), []);
  assert.deepEqual(await deviceField(camera, "editorUserIds"), []);
  assert.equal(await recomputeEditors(getFirestore(), uniq("missing")), undefined);
});

async function seedHubWithViewer() {
  const hub = uniq("hub");
  const viewer = uniq("viewer");
  const viewerOwner = uniq("uid-viewer");
  const hubOwner = uniq("uid-hub");
  await seedDevice(hub, hubOwner);
  await seedDevice(viewer, viewerOwner);
  await getFirestore()
    .collection("pairings")
    .doc(pairingIdFor(hub, viewer))
    .set({ memberDeviceIds: [hub, viewer], status: "active" });
  return { hub, viewer, viewerOwner, hubOwner };
}

async function seedHostedCamera(
  id: string,
  hostDeviceId: string,
  ownerUserId: string,
  extra: Record<string, unknown> = {}
) {
  await seedDevice(id, ownerUserId, { platform: "ipCamera", hostDeviceId, ...extra });
}

test("recomputeEditors mirrors the hub's editors onto its hosted cameras", async () => {
  const { hub, viewerOwner, hubOwner } = await seedHubWithViewer();
  const camera = uniq("ipcam");
  await seedHostedCamera(camera, hub, hubOwner);

  await recomputeEditors(getFirestore(), hub);

  assert.deepEqual(await deviceField(camera, "editorUserIds"), [viewerOwner]);
});

test("unpairing clears hosted camera editors", async () => {
  const { hub, viewer, viewerOwner, hubOwner } = await seedHubWithViewer();
  const camera = uniq("ipcam");
  await seedHostedCamera(camera, hub, hubOwner);
  await recomputeEditors(getFirestore(), hub);
  assert.deepEqual(await deviceField(camera, "editorUserIds"), [viewerOwner]);

  await getFirestore().collection("pairings").doc(pairingIdFor(hub, viewer)).update({ status: "removed" });
  await recomputeEditors(getFirestore(), hub);

  assert.deepEqual(await deviceField(camera, "editorUserIds"), []);
});

test("hosted camera created after pairing gets editors", async () => {
  const { hub, viewerOwner, hubOwner } = await seedHubWithViewer();
  await recomputeEditors(getFirestore(), hub);
  const camera = uniq("ipcam");
  await seedHostedCamera(camera, hub, hubOwner);
  assert.equal(await deviceField(camera, "editorUserIds"), undefined);

  const snapshot = await getFirestore().collection("devices").doc(camera).get();
  const handler = syncHostedCameraEditors as unknown as {
    run: (event: { data: unknown; params: { deviceId: string } }) => Promise<void>;
  };
  await handler.run({ data: snapshot, params: { deviceId: camera } });

  assert.deepEqual(await deviceField(camera, "editorUserIds"), [viewerOwner]);
});

test("cameras of other hubs are untouched", async () => {
  const { hub } = await seedHubWithViewer();
  const other = uniq("ipcam-other");
  await seedHostedCamera(other, uniq("other-hub"), uniq("uid-other"), { editorUserIds: ["keep-me"] });

  await recomputeEditors(getFirestore(), hub);

  assert.deepEqual(await deviceField(other, "editorUserIds"), ["keep-me"]);
});

test("a camera claiming another owner's hub gets no editors from the trigger or the mirror", async () => {
  const { hub } = await seedHubWithViewer();
  await recomputeEditors(getFirestore(), hub);
  const forged = uniq("ipcam-forged");
  await seedDevice(forged, uniq("uid-attacker"), { platform: "ipCamera", hostDeviceId: hub });

  const snapshot = await getFirestore().collection("devices").doc(forged).get();
  const handler = syncHostedCameraEditors as unknown as {
    run: (event: { data: unknown; params: { deviceId: string } }) => Promise<void>;
  };
  await handler.run({ data: snapshot, params: { deviceId: forged } });
  assert.equal(await deviceField(forged, "editorUserIds"), undefined);

  const touched = await mirrorEditorsToHostedCameras(getFirestore(), hub, ["anyone"]);
  assert.equal(touched, 0);
  assert.equal(await deviceField(forged, "editorUserIds"), undefined);
});

test("ownersNeedingPremiumSync only reacts to premium or owner changes", () => {
  assert.deepEqual(ownersNeedingPremiumSync({ ownerUserId: "u" }, { ownerUserId: "u", lastSeenAt: 1 } as never), []);
  assert.deepEqual(ownersNeedingPremiumSync(undefined, { ownerUserId: "u" }), []);
  assert.deepEqual(ownersNeedingPremiumSync(undefined, { ownerUserId: "u", premiumActive: true }), ["u"]);
  assert.deepEqual(
    ownersNeedingPremiumSync({ ownerUserId: "u", premiumActive: true }, { ownerUserId: "u", premiumActive: false }),
    ["u"]
  );
  assert.deepEqual(
    ownersNeedingPremiumSync({ ownerUserId: "old", premiumActive: true }, { ownerUserId: "new", premiumActive: true }),
    ["old", "new"]
  );
  assert.deepEqual(ownersNeedingPremiumSync({ ownerUserId: "u", premiumActive: true }, undefined), ["u"]);
  assert.deepEqual(ownersNeedingPremiumSync({ ownerUserId: "old" }, { ownerUserId: "new" }), []);
});

test("syncOwnerPremium marks a user premium while any of their devices is premium", async () => {
  const owner = uniq("owner");
  const first = uniq("dev");
  const second = uniq("dev");
  await seedDevice(first, owner, { premiumActive: false });
  await seedDevice(second, owner, { premiumActive: true });
  const users = getFirestore().collection("users");

  assert.equal(await syncOwnerPremium(getFirestore(), owner), true);
  assert.equal((await users.doc(owner).get()).get("premium"), true);

  await getFirestore().collection("devices").doc(second).update({ premiumActive: false });
  assert.equal(await syncOwnerPremium(getFirestore(), owner), false);
  assert.equal((await users.doc(owner).get()).get("premium"), false);
});
