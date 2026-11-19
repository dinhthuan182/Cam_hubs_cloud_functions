import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { onDetectionEvent } from "../src/index";
import { pairingIdFor } from "../src/pairing";

const handler = onDetectionEvent as unknown as {
  run: (event: { data: unknown; params: { eventId: string } }) => Promise<void>;
};

function uniq(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

async function seedViewer(id: string, token: string) {
  await getFirestore()
    .collection("devices")
    .doc(id)
    .set({ ownerUserId: uniq("uid"), premiumActive: true, fcmToken: token });
}

async function seedPairing(a: string, b: string) {
  await getFirestore()
    .collection("pairings")
    .doc(pairingIdFor(a, b))
    .set({ memberDeviceIds: [a, b], status: "active" });
}

async function sentTokens(cameraDeviceId: string): Promise<string[]> {
  const sent: string[][] = [];
  const messaging = getMessaging() as unknown as {
    sendEachForMulticast: (message: { tokens: string[] }) => Promise<unknown>;
  };
  const original = messaging.sendEachForMulticast;
  messaging.sendEachForMulticast = async (message) => {
    sent.push(message.tokens);
    return { successCount: message.tokens.length, failureCount: 0, responses: message.tokens.map(() => ({ success: true })) };
  };
  try {
    const eventId = uniq("event");
    const ref = getFirestore().collection("cameraEvents").doc(eventId);
    await ref.set({ cameraDeviceId, eventType: "motion", detectedAt: Timestamp.now() });
    await handler.run({ data: await ref.get(), params: { eventId } });
  } finally {
    messaging.sendEachForMulticast = original;
  }
  return sent.flat();
}

test("onDetectionEvent notifies the hub's paired viewers for a hosted camera and never the hub itself", async () => {
  const hub = uniq("hub");
  const viewer = uniq("viewer");
  const camera = uniq("ipcam");
  const owner = uniq("uid-hub");
  await getFirestore().collection("devices").doc(hub).set({ ownerUserId: owner, premiumActive: true, fcmToken: "tokenHub" });
  await seedViewer(viewer, "tokenV");
  await seedPairing(hub, viewer);
  await getFirestore()
    .collection("devices")
    .doc(camera)
    .set({ ownerUserId: owner, platform: "ipCamera", hostDeviceId: hub, premiumActive: true, fcmToken: "tokenCam" });

  assert.deepEqual(await sentTokens(camera), ["tokenV"]);
});

test("onDetectionEvent ignores a hostDeviceId naming a hub with a different owner", async () => {
  const hub = uniq("hub");
  const viewer = uniq("viewer");
  const camera = uniq("ipcam-forged");
  await getFirestore().collection("devices").doc(hub).set({ ownerUserId: uniq("uid-hub") });
  await seedViewer(viewer, "tokenVictim");
  await seedPairing(hub, viewer);
  await getFirestore()
    .collection("devices")
    .doc(camera)
    .set({ ownerUserId: uniq("uid-attacker"), platform: "ipCamera", hostDeviceId: hub });

  assert.deepEqual(await sentTokens(camera), []);
});

test("onDetectionEvent still alerts the viewers of a phone camera", async () => {
  const camera = uniq("phone");
  const viewer = uniq("viewer");
  await getFirestore().collection("devices").doc(camera).set({ ownerUserId: uniq("uid") });
  await seedViewer(viewer, "tokenPhoneViewer");
  await seedPairing(camera, viewer);

  assert.deepEqual(await sentTokens(camera), ["tokenPhoneViewer"]);
});
