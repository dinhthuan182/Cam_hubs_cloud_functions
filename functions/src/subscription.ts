import { createHash, timingSafeEqual } from "crypto";

export type SubscriptionStatus =
  | "active"
  | "in_grace"
  | "in_billing_retry"
  | "paused"
  | "expired"
  | "cancelled"
  | "refunded";

export interface AdaptyWebhookEvent {
  event_type?: string;
  event_datetime?: string;
  event_api_datetime?: string;
  profile_id?: string;
  customer_user_id?: string;
  event_properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SubscriptionRecord {
  status: SubscriptionStatus;
  willAutoRenew: boolean;
  isInTrial: boolean;
  startAt: number | null;
  expiresAt: number | null;
  gracePeriodExpiresAt: number | null;
  premiumExpiresAt: number | null;
  cancelledAt: number | null;
  cancellationReason: string | null;
  latestEventType: string;
  latestEventAt: number;
  updatedAt: number;
  originalTransactionId: string | null;
  profileId: string | null;
  profileEventId: string | null;
  transactionId: string | null;
  vendorProductId: string | null;
  store: string | null;
  environment: string | null;
}

export interface MappedSubscription {
  deviceId: string;
  premium: boolean;
  latestEventAt: number;
  record: SubscriptionRecord;
}

export type MapResult =
  | { ok: true; value: MappedSubscription }
  | { ok: false; reason: "unmapped" | "sandbox" | "no_user" | "no_event" | "unknown_event" };

export function verifyWebhookSecret(header: string | undefined, expected: string | undefined): boolean {
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof header !== "string" || header.length === 0) return false;
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function shouldApply(
  incomingEventId: string | null,
  incomingEventAt: number,
  storedEventId: string | null | undefined,
  storedEventAt: number | null | undefined
): boolean {
  const haveBothIds =
    incomingEventId !== null && storedEventId !== null && storedEventId !== undefined;
  if (haveBothIds && incomingEventId === storedEventId) return false;
  if (storedEventAt === null || storedEventAt === undefined) return true;
  if (!haveBothIds) return incomingEventAt > storedEventAt;
  return incomingEventAt >= storedEventAt;
}

function toMillis(value: unknown): number | null {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

function prop(event: AdaptyWebhookEvent, ...keys: string[]): unknown {
  const nested = (event.event_properties ?? {}) as Record<string, unknown>;
  const top = event as Record<string, unknown>;
  for (const key of keys) {
    if (nested[key] !== undefined && nested[key] !== null) return nested[key];
    if (top[key] !== undefined && top[key] !== null) return top[key];
  }
  return undefined;
}

function isProduction(event: AdaptyWebhookEvent): boolean {
  if (process.env.ADAPTY_ALLOW_SANDBOX === "true") return true;
  const raw = prop(event, "environment", "store_environment", "environment_name");
  if (typeof raw === "string" && raw.length > 0) {
    return !raw.toLowerCase().includes("sandbox");
  }
  return true;
}

function statusForEventType(eventType: string): SubscriptionStatus | null {
  switch (eventType) {
    case "subscription_expired":
    case "trial_expired":
      return "expired";
    case "subscription_refunded":
    case "non_subscription_purchase_refunded":
    case "refund":
      return "refunded";
    case "subscription_paused":
      return "paused";
    case "subscription_renewal_cancelled":
    case "trial_renewal_cancelled":
    case "subscription_cancelled":
      return "cancelled";
    case "billing_issue_detected":
    case "entered_grace_period":
    case "grace_period_started":
      return "in_grace";
    case "billing_retry_entered":
      return "in_billing_retry";
    case "subscription_started":
    case "subscription_renewed":
    case "subscription_renewal_reactivated":
    case "subscription_deferred":
    case "non_subscription_purchase":
    case "trial_started":
    case "trial_converted":
    case "trial_renewal_reactivated":
    case "subscription_initial_purchase":
    case "subscription_restored":
      return "active";
    default:
      return null;
  }
}

function statusForAccessLevel(event: AdaptyWebhookEvent): SubscriptionStatus {
  if (Boolean(prop(event, "is_refund"))) return "refunded";
  const isActiveRaw = prop(event, "is_active");
  const isActive = isActiveRaw === undefined ? true : Boolean(isActiveRaw);
  if (!isActive) return "expired";
  if (Boolean(prop(event, "is_in_grace_period"))) return "in_grace";
  return "active";
}

function str(event: AdaptyWebhookEvent, ...keys: string[]): string | null {
  const raw = prop(event, ...keys);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function computePremium(status: SubscriptionStatus, premiumExpiresAt: number | null, nowMs: number): boolean {
  if (status === "expired" || status === "refunded" || status === "paused") return false;
  if (premiumExpiresAt !== null && premiumExpiresAt <= nowMs) return false;
  return true;
}

export function mapEventToSubscription(event: AdaptyWebhookEvent, nowMs: number): MapResult {
  const deviceId = typeof event.customer_user_id === "string" ? event.customer_user_id.trim() : "";
  if (deviceId.length === 0) return { ok: false, reason: "no_user" };
  const eventType = typeof event.event_type === "string" ? event.event_type : "";
  if (eventType.length === 0) return { ok: false, reason: "no_event" };
  if (!isProduction(event)) return { ok: false, reason: "sandbox" };

  const latestEventAt = toMillis(event.event_datetime ?? event.event_api_datetime) ?? nowMs;
  const status =
    eventType === "access_level_updated" ? statusForAccessLevel(event) : statusForEventType(eventType);
  if (status === null) return { ok: false, reason: "unknown_event" };
  const expiresAt = toMillis(prop(event, "subscription_expires_at", "expires_at", "expiration_at", "expires_date"));
  const gracePeriodExpiresAt = toMillis(prop(event, "grace_period_expires_at", "grace_period_expires_date"));
  const startAt = toMillis(prop(event, "purchase_date", "starts_at", "current_period_started_at"));
  const premiumExpiresAt =
    gracePeriodExpiresAt !== null
      ? Math.max(gracePeriodExpiresAt, expiresAt ?? gracePeriodExpiresAt)
      : expiresAt;

  const willRenewRaw = prop(event, "will_renew", "auto_renew_status");
  const willAutoRenew =
    status === "cancelled" || status === "expired" || status === "refunded"
      ? false
      : willRenewRaw === undefined
        ? true
        : Boolean(willRenewRaw);

  const trialEvents = new Set([
    "trial_started",
    "trial_renewal_cancelled",
    "trial_renewal_reactivated",
  ]);
  const isInTrial =
    (trialEvents.has(eventType) || Boolean(prop(event, "is_in_trial", "is_trial"))) &&
    eventType !== "trial_converted" &&
    eventType !== "trial_expired";
  const cancellationReasonRaw = prop(event, "cancellation_reason");
  const cancellationReason = typeof cancellationReasonRaw === "string" ? cancellationReasonRaw : null;
  const cancelledAt =
    status === "cancelled" || status === "refunded"
      ? toMillis(prop(event, "cancellation_time", "cancelled_at")) ?? latestEventAt
      : null;

  const premium = computePremium(status, premiumExpiresAt, nowMs);

  const record: SubscriptionRecord = {
    status,
    willAutoRenew,
    isInTrial,
    startAt,
    expiresAt,
    gracePeriodExpiresAt,
    premiumExpiresAt,
    cancelledAt,
    cancellationReason,
    latestEventType: eventType,
    latestEventAt,
    updatedAt: nowMs,
    originalTransactionId: str(event, "original_transaction_id", "vendor_original_transaction_id"),
    profileId: str(event, "profile_id"),
    profileEventId: str(event, "profile_event_id"),
    transactionId: str(event, "transaction_id", "vendor_transaction_id"),
    vendorProductId: str(event, "vendor_product_id"),
    store: str(event, "store"),
    environment: str(event, "environment", "store_environment", "environment_name"),
  };

  return { ok: true, value: { deviceId, premium, latestEventAt, record } };
}
