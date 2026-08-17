import { test } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { adaptySubscriptionWebhook } from "../src/index";

const SECRET = "webhook-test-secret";

interface CapturedResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

function purchaseFor(deviceId: string, profileEventId: string): Record<string, unknown> {
  return {
    event_type: "subscription_initial_purchase",
    event_datetime: new Date().toISOString(),
    customer_user_id: deviceId,
    profile_event_id: profileEventId,
    original_transaction_id: "otx-webhook",
    event_properties: {
      environment: "Production",
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      will_renew: true,
    },
  };
}

function invoke(body: unknown): Promise<CapturedResponse> {
  process.env.ADAPTY_WEBHOOK_SECRET = SECRET;
  return new Promise((resolve, reject) => {
    const req = {
      method: "POST",
      body,
      get: (h: string) => (h.toLowerCase() === "authorization" ? `Bearer ${SECRET}` : undefined),
    };
    const captured: CapturedResponse = { statusCode: 0, body: {} };
    const res = {
      status(code: number) {
        captured.statusCode = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        captured.body = payload;
        resolve(captured);
        return this;
      },
    };
    try {
      const maybe = (adaptySubscriptionWebhook as unknown as (r: unknown, s: unknown) => unknown)(req, res);
      Promise.resolve(maybe).catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

test("a purchase for an unregistered device writes the entitlement but does NOT create the device record", async () => {
  const deviceId = "unregistered-device";
  const res = await invoke(purchaseFor(deviceId, "evt-unregistered"));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.premium, true);
  assert.equal(res.body.applied, true);

  const db = getFirestore();
  const sub = await db.collection("subscriptions").doc(deviceId).get();
  assert.equal(sub.exists, true);
  assert.equal(sub.get("premium"), true);
  assert.equal(sub.get("originalTransactionId"), "otx-webhook");

  const device = await db.collection("devices").doc(deviceId).get();
  assert.equal(device.exists, false, "the webhook must never fabricate a device document");
});

test("a purchase for an already-registered device mirrors premiumActive onto the existing record", async () => {
  const deviceId = "registered-device";
  await getFirestore()
    .collection("devices")
    .doc(deviceId)
    .set({ ownerUserId: "owner-registered", premiumActive: false });

  const res = await invoke(purchaseFor(deviceId, "evt-registered"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.premium, true);

  const device = await getFirestore().collection("devices").doc(deviceId).get();
  assert.equal(device.exists, true);
  assert.equal(device.get("premiumActive"), true);
  assert.equal(device.get("ownerUserId"), "owner-registered");
});
