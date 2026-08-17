import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AdaptyWebhookEvent,
  mapEventToSubscription,
  shouldApply,
  verifyWebhookSecret,
} from "../src/subscription";

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const FUTURE = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();

function purchase(overrides: Partial<AdaptyWebhookEvent> = {}): AdaptyWebhookEvent {
  return {
    event_type: "subscription_initial_purchase",
    event_datetime: new Date(NOW).toISOString(),
    customer_user_id: "uid-1",
    event_properties: {
      environment: "Production",
      expires_at: FUTURE,
      purchase_date: new Date(NOW).toISOString(),
      will_renew: true,
      vendor_product_id: "cam_premium_annual",
      store: "app_store",
      price: 29.99,
      currency: "USD",
      original_transaction_id: "otx-123",
    },
    ...overrides,
  };
}

test("an unconfigured secret rejects every request (fail closed)", () => {
  assert.equal(verifyWebhookSecret("Bearer abc", undefined), false);
  assert.equal(verifyWebhookSecret("Bearer abc", ""), false);
});

test("a missing or wrong Authorization header is rejected", () => {
  assert.equal(verifyWebhookSecret(undefined, "s3cret"), false);
  assert.equal(verifyWebhookSecret("", "s3cret"), false);
  assert.equal(verifyWebhookSecret("Bearer wrong", "s3cret"), false);
});

test("the configured secret is accepted with or without the Bearer prefix", () => {
  assert.equal(verifyWebhookSecret("Bearer s3cret", "s3cret"), true);
  assert.equal(verifyWebhookSecret("s3cret", "s3cret"), true);
});

test("a purchase grants premium", () => {
  const result = mapEventToSubscription(purchase(), NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.deviceId, "uid-1");
  assert.equal(result.value.premium, true);
  assert.equal(result.value.record.status, "active");
  assert.equal(result.value.record.willAutoRenew, true);
});

test("subscription_expires_at populates expiresAt and drives premium expiry", () => {
  const active = mapEventToSubscription(
    purchase({ event_properties: { environment: "Production", subscription_expires_at: FUTURE } }),
    NOW
  );
  assert.equal(active.ok, true);
  if (active.ok) {
    assert.equal(active.value.record.expiresAt, Date.parse(FUTURE));
    assert.equal(active.value.premium, true);
  }

  const lapsed = mapEventToSubscription(
    purchase({ event_properties: { environment: "Production", subscription_expires_at: PAST } }),
    NOW
  );
  assert.equal(lapsed.ok, true);
  if (lapsed.ok) {
    assert.equal(lapsed.value.record.expiresAt, Date.parse(PAST));
    assert.equal(lapsed.value.premium, false);
  }
});

test("expiry, refund, and lapsed cancellation clear premium", () => {
  const expired = mapEventToSubscription(
    purchase({ event_type: "subscription_expired", event_properties: { environment: "Production", expires_at: PAST } }),
    NOW
  );
  const refunded = mapEventToSubscription(
    purchase({ event_type: "subscription_refunded" }),
    NOW
  );
  const lapsed = mapEventToSubscription(
    purchase({ event_type: "subscription_cancelled", event_properties: { environment: "Production", expires_at: PAST } }),
    NOW
  );
  for (const r of [expired, refunded, lapsed]) {
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.premium, false);
  }
});

test("a cancellation whose term has not yet ended keeps premium until expiry", () => {
  const result = mapEventToSubscription(
    purchase({ event_type: "subscription_cancelled" }),
    NOW
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.premium, true);
  assert.equal(result.value.record.status, "cancelled");
  assert.equal(result.value.record.willAutoRenew, false);
});

test("a billing grace period keeps premium while the grace window is open", () => {
  const result = mapEventToSubscription(
    purchase({
      event_type: "billing_issue_detected",
      event_properties: { environment: "Production", expires_at: PAST, grace_period_expires_at: FUTURE },
    }),
    NOW
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.record.status, "in_grace");
  assert.equal(result.value.premium, true);
});

test("a sandbox event never grants production premium", () => {
  const result = mapEventToSubscription(
    purchase({ event_properties: { environment: "Sandbox", expires_at: FUTURE } }),
    NOW
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "sandbox");
});

test("a lower-cased sandbox environment is still rejected", () => {
  const result = mapEventToSubscription(
    purchase({ event_properties: { environment: "sandbox", expires_at: FUTURE } }),
    NOW
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "sandbox");
});

test("a production event is granted even when the environment field is absent", () => {
  const result = mapEventToSubscription(
    purchase({ event_properties: { expires_at: FUTURE } }),
    NOW
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.premium, true);
});

test("a production environment carried under an alternate key is granted", () => {
  const result = mapEventToSubscription(
    purchase({ event_properties: { store_environment: "Production", expires_at: FUTURE } }),
    NOW
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.premium, true);
});

test("an event with no customer_user_id is unmapped", () => {
  const result = mapEventToSubscription(purchase({ customer_user_id: undefined }), NOW);
  assert.equal(result.ok, false);
});

test("the subscription record carries lifecycle and subscription-identity fields, and nothing else", () => {
  const result = mapEventToSubscription(purchase(), NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const keys = Object.keys(result.value.record).sort();
  assert.deepEqual(keys, [
    "cancellationReason",
    "cancelledAt",
    "environment",
    "expiresAt",
    "gracePeriodExpiresAt",
    "isInTrial",
    "latestEventAt",
    "latestEventType",
    "originalTransactionId",
    "premiumExpiresAt",
    "profileEventId",
    "profileId",
    "startAt",
    "status",
    "store",
    "transactionId",
    "updatedAt",
    "vendorProductId",
    "willAutoRenew",
  ]);
  const forbidden = ["price", "currency", "idfa", "idfv", "advertising_id", "profile_ip_address"];
  const record = result.value.record as unknown as Record<string, unknown>;
  for (const k of forbidden) {
    assert.equal(record[k], undefined);
  }
});

test("subscription identity fields are mapped from event_properties and the top level alike", () => {
  const nested = mapEventToSubscription(
    purchase({ event_properties: { environment: "Production", expires_at: FUTURE, original_transaction_id: "otx-nested" } }),
    NOW
  );
  assert.equal(nested.ok, true);
  if (!nested.ok) return;
  assert.equal(nested.value.record.originalTransactionId, "otx-nested");

  const flat = mapEventToSubscription(
    purchase({
      event_properties: { environment: "Production", expires_at: FUTURE, vendor_product_id: "cam_premium_annual", store: "app_store" },
      original_transaction_id: "otx-flat",
      profile_id: "prof-1",
      profile_event_id: "evt-1",
    }),
    NOW
  );
  assert.equal(flat.ok, true);
  if (!flat.ok) return;
  assert.equal(flat.value.record.originalTransactionId, "otx-flat");
  assert.equal(flat.value.record.profileId, "prof-1");
  assert.equal(flat.value.record.profileEventId, "evt-1");
  assert.equal(flat.value.record.vendorProductId, "cam_premium_annual");
  assert.equal(flat.value.record.store, "app_store");
  assert.equal(flat.value.record.environment, "Production");
});

test("an unrecognized event type is not applied and never grants premium", () => {
  const result = mapEventToSubscription(purchase({ event_type: "some_future_adapty_event" }), NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unknown_event");
});

test("every documented Adapty event type maps to a status", () => {
  const documented = [
    "subscription_started",
    "subscription_initial_purchase",
    "subscription_renewed",
    "subscription_renewal_cancelled",
    "subscription_renewal_reactivated",
    "subscription_expired",
    "subscription_paused",
    "subscription_deferred",
    "subscription_refunded",
    "subscription_restored",
    "trial_started",
    "trial_converted",
    "trial_renewal_cancelled",
    "trial_renewal_reactivated",
    "trial_expired",
    "non_subscription_purchase",
    "non_subscription_purchase_refunded",
    "entered_grace_period",
    "billing_issue_detected",
    "access_level_updated",
  ];
  for (const eventType of documented) {
    const result = mapEventToSubscription(purchase({ event_type: eventType }), NOW);
    assert.equal(result.ok, true, `${eventType} should map`);
  }
});

test("active-lifecycle events grant premium while the term is open", () => {
  for (const eventType of [
    "subscription_started",
    "subscription_renewed",
    "subscription_renewal_reactivated",
    "subscription_deferred",
    "trial_converted",
    "trial_renewal_reactivated",
  ]) {
    const result = mapEventToSubscription(purchase({ event_type: eventType }), NOW);
    assert.equal(result.ok, true, eventType);
    if (!result.ok) continue;
    assert.equal(result.value.premium, true, eventType);
    assert.equal(result.value.record.status, "active", eventType);
  }
});

test("terminal events clear premium", () => {
  const clearing: Array<[string, Partial<AdaptyWebhookEvent>]> = [
    ["subscription_expired", { event_properties: { environment: "Production", expires_at: PAST } }],
    ["trial_expired", { event_properties: { environment: "Production", expires_at: PAST } }],
    ["subscription_paused", {}],
    ["subscription_refunded", {}],
    ["non_subscription_purchase_refunded", {}],
  ];
  for (const [event_type, overrides] of clearing) {
    const result = mapEventToSubscription(purchase({ event_type, ...overrides }), NOW);
    assert.equal(result.ok, true, event_type);
    if (!result.ok) continue;
    assert.equal(result.value.premium, false, event_type);
  }
});

test("subscription_paused reports a paused status", () => {
  const result = mapEventToSubscription(purchase({ event_type: "subscription_paused" }), NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.record.status, "paused");
  assert.equal(result.value.premium, false);
});

test("entered_grace_period keeps premium while the grace window is open", () => {
  const result = mapEventToSubscription(
    purchase({
      event_type: "entered_grace_period",
      event_properties: { environment: "Production", expires_at: PAST, grace_period_expires_at: FUTURE },
    }),
    NOW
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.record.status, "in_grace");
  assert.equal(result.value.premium, true);
});

test("trial_renewal_cancelled keeps premium and stays in trial until expiry", () => {
  const result = mapEventToSubscription(purchase({ event_type: "trial_renewal_cancelled" }), NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.record.status, "cancelled");
  assert.equal(result.value.record.isInTrial, true);
  assert.equal(result.value.record.willAutoRenew, false);
  assert.equal(result.value.premium, true);
});

test("trial_started marks the record in trial", () => {
  const result = mapEventToSubscription(purchase({ event_type: "trial_started" }), NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.record.isInTrial, true);
  assert.equal(result.value.premium, true);
});

test("trial_converted leaves trial and keeps premium", () => {
  const result = mapEventToSubscription(
    purchase({ event_type: "trial_converted", event_properties: { environment: "Production", expires_at: FUTURE, is_in_trial: false } }),
    NOW
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.record.isInTrial, false);
  assert.equal(result.value.record.status, "active");
  assert.equal(result.value.premium, true);
});

test("non_subscription_purchase grants premium", () => {
  const result = mapEventToSubscription(
    purchase({ event_type: "non_subscription_purchase", event_properties: { environment: "Production" } }),
    NOW
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.record.status, "active");
  assert.equal(result.value.premium, true);
});

test("access_level_updated is authoritative: is_active drives premium", () => {
  const active = mapEventToSubscription(
    purchase({ event_type: "access_level_updated", event_properties: { environment: "Production", is_active: true, expires_at: FUTURE } }),
    NOW
  );
  assert.equal(active.ok, true);
  if (active.ok) {
    assert.equal(active.value.record.status, "active");
    assert.equal(active.value.premium, true);
  }

  const inactive = mapEventToSubscription(
    purchase({ event_type: "access_level_updated", event_properties: { environment: "Production", is_active: false, expires_at: FUTURE } }),
    NOW
  );
  assert.equal(inactive.ok, true);
  if (inactive.ok) {
    assert.equal(inactive.value.record.status, "expired");
    assert.equal(inactive.value.premium, false);
  }

  const grace = mapEventToSubscription(
    purchase({ event_type: "access_level_updated", event_properties: { environment: "Production", is_active: true, is_in_grace_period: true, expires_at: FUTURE } }),
    NOW
  );
  assert.equal(grace.ok, true);
  if (grace.ok) assert.equal(grace.value.record.status, "in_grace");

  const refund = mapEventToSubscription(
    purchase({ event_type: "access_level_updated", event_properties: { environment: "Production", is_active: false, is_refund: true } }),
    NOW
  );
  assert.equal(refund.ok, true);
  if (refund.ok) {
    assert.equal(refund.value.record.status, "refunded");
    assert.equal(refund.value.premium, false);
  }
});

test("without event ids, ordering falls back to strictly newer", () => {
  const stored = NOW;
  assert.equal(shouldApply(null, NOW + 1000, undefined, stored), true);
  assert.equal(shouldApply(null, NOW, undefined, stored), false);
  assert.equal(shouldApply(null, NOW - 1000, undefined, stored), false);
  assert.equal(shouldApply(null, NOW, undefined, undefined), true);
});

test("an identical profile_event_id is never applied twice, even with a later timestamp", () => {
  assert.equal(shouldApply("evt-1", NOW + 5000, "evt-1", NOW), false);
});

test("two distinct events sharing one event_datetime both apply", () => {
  assert.equal(shouldApply("evt-2", NOW, "evt-1", NOW), true);
});

test("a distinct but older event does not overwrite newer stored state", () => {
  assert.equal(shouldApply("evt-2", NOW - 1000, "evt-1", NOW), false);
});

test("the first event for a device applies with no stored state", () => {
  assert.equal(shouldApply("evt-1", NOW, undefined, undefined), true);
});
