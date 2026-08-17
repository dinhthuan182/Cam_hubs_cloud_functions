import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { getStorage } from "firebase-admin/storage";
import { selectBodyLocKey, eligibleRecipientToken } from "./notification";
import { sweepStaleSessions } from "./sweepStaleSessions";
import { reapExpiredClips } from "./reapExpiredClips";
import {
  AdaptyWebhookEvent,
  SubscriptionRecord,
  mapEventToSubscription,
  shouldApply,
  verifyWebhookSecret,
} from "./subscription";

initializeApp();
const db = getFirestore();

interface DetectionEventData {
  cameraDeviceId?: string;
  eventType?: "motion" | "sound" | "liveStarted" | "liveEnded";
  detectedAt?: Timestamp;
  category?: "person" | "pet" | "vehicle" | "otherMotion" | "sound";
  snapshotUrl?: string;
}

export const onDetectionEvent = onDocumentCreated(
  "cameraEvents/{eventId}",
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("onDetectionEvent: missing snapshot");
      return;
    }

    const data = snap.data() as DetectionEventData;
    const eventId = event.params.eventId;
    const cameraDeviceId = data.cameraDeviceId;
    const eventType = data.eventType;
    if (!cameraDeviceId || !eventType) {
      logger.warn("onDetectionEvent: missing cameraDeviceId or eventType");
      return;
    }

    if (eventType === "liveStarted" || eventType === "liveEnded") {
      return;
    }

    const pairingsSnap = await db
      .collection("pairings")
      .where("memberDeviceIds", "array-contains", cameraDeviceId)
      .where("status", "==", "active")
      .get();

    const viewerIds = new Set<string>();
    for (const doc of pairingsSnap.docs) {
      const members: string[] = doc.get("memberDeviceIds") ?? [];
      for (const id of members) {
        if (id !== cameraDeviceId) viewerIds.add(id);
      }
    }
    if (viewerIds.size === 0) {
      logger.info(`onDetectionEvent: no paired viewers for ${cameraDeviceId}`);
      return;
    }

    const tokenToViewer = new Map<string, string>();
    await Promise.all(
      [...viewerIds].map(async (viewerId) => {
        const deviceSnap = await db.collection("devices").doc(viewerId).get();
        if (!deviceSnap.exists) return;
        const token = eligibleRecipientToken(
          {
            activelyWatchingCameraId: deviceSnap.get("activelyWatchingCameraId"),
            premiumActive: deviceSnap.get("premiumActive"),
            fcmToken: deviceSnap.get("fcmToken"),
          },
          cameraDeviceId
        );
        if (token) {
          tokenToViewer.set(token, viewerId);
        }
      })
    );

    if (tokenToViewer.size === 0) {
      logger.info(`onDetectionEvent: no eligible tokens for ${cameraDeviceId}`);
      return;
    }

    const cameraSnap = await db.collection("devices").doc(cameraDeviceId).get();
    const cameraName = (cameraSnap.get("displayName") as string | undefined) ?? "Camera";
    const category = data.category;
    const bodyLocKey = selectBodyLocKey(category, eventType);
    const detectedAtMs = data.detectedAt ? String(data.detectedAt.toMillis()) : String(Date.now());
    const snapshotUrl = typeof data.snapshotUrl === "string" ? data.snapshotUrl : undefined;

    const tokens = [...tokenToViewer.keys()];
    const response = await getMessaging().sendEachForMulticast({
      tokens,
      data: {
        eventId,
        cameraDeviceId,
        eventType,
        detectedAtMs,
        ...(category ? { category } : {}),
        ...(snapshotUrl ? { snapshotUrl } : {}),
      },
      apns: {
        headers: { "apns-priority": "10" },
        payload: {
          aps: {
            alert: { title: cameraName, locKey: bodyLocKey },
            sound: "default",
            mutableContent: true,
          },
        },
      },
    });
    logger.info(
      `onDetectionEvent: ${response.successCount}/${tokens.length} delivered for ${cameraDeviceId}`
    );

    const cleanups: Promise<unknown>[] = [];
    response.responses.forEach((resp, i) => {
      if (resp.success) return;
      const code = resp.error?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument"
      ) {
        const viewerId = tokenToViewer.get(tokens[i]);
        if (viewerId) {
          logger.info(`onDetectionEvent: pruning stale fcmToken for viewer=${viewerId} (${code})`);
          cleanups.push(
            db.collection("devices").doc(viewerId).update({ fcmToken: FieldValue.delete() })
          );
        }
      } else if (resp.error) {
        logger.warn(`onDetectionEvent: transient send error (${code})`);
      }
    });
    await Promise.all(cleanups);
  }
);

export const reapExpiredClipsScheduled = onSchedule("every 24 hours", async () => {
  const dryRun = process.env.REAP_DRY_RUN !== "false";
  const result = await reapExpiredClips(db, getStorage().bucket(), { dryRun, now: Date.now() });
  logger.info(
    `reapExpiredClips: dryRun=${dryRun} considered=${result.considered} ` +
      `skippedFavorites=${result.skippedFavorites} deletedObjects=${result.deletedObjects} ` +
      `clearedEvents=${result.clearedEvents} failed=${result.failed}`
  );
  if (result.expired.length > 0) {
    logger.info(`reapExpiredClips: ids=${result.expired.join(",")}`);
  }
});

async function deviceOwnerUid(deviceId: string): Promise<string | undefined> {
  const snap = await db.collection("devices").doc(deviceId).get();
  const owner = snap.get("ownerUserId");
  return typeof owner === "string" && owner.length > 0 ? owner : undefined;
}

async function devicesArePaired(deviceA: string, deviceB: string): Promise<boolean> {
  const snap = await db
    .collection("pairings")
    .where("memberDeviceIds", "array-contains", deviceA)
    .where("status", "==", "active")
    .get();
  return snap.docs.some((doc) => ((doc.get("memberDeviceIds") ?? []) as string[]).includes(deviceB));
}

export const authorizeDetection = onCall(async (request): Promise<{ authorized: boolean }> => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign-in required to authorize detection.");
  }
  const data = (request.data ?? {}) as Record<string, unknown>;
  const cameraDeviceId = typeof data.cameraDeviceId === "string" ? data.cameraDeviceId.trim() : "";
  if (cameraDeviceId.length === 0) {
    throw new HttpsError("invalid-argument", "cameraDeviceId is required.");
  }

  const settingsRef = db.collection("detectionSettings").doc(cameraDeviceId);
  const rawAuthorizer = data.authorizerDeviceId;

  if (rawAuthorizer === null || rawAuthorizer === undefined) {
    await settingsRef.set(
      {
        detectionAuthorizedBy: FieldValue.delete(),
        detectionAuthorizedAt: FieldValue.delete(),
      },
      { merge: true }
    );
    logger.info(`authorizeDetection: revoked camera=${cameraDeviceId}`);
    return { authorized: false };
  }

  const authorizerDeviceId = typeof rawAuthorizer === "string" ? rawAuthorizer.trim() : "";
  if (authorizerDeviceId.length === 0) {
    throw new HttpsError("invalid-argument", "authorizerDeviceId must be a non-empty string or null.");
  }

  const ownerUid = await deviceOwnerUid(authorizerDeviceId);
  if (!ownerUid || ownerUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Caller does not own the authorizing device.");
  }

  const subSnap = await db.collection("subscriptions").doc(authorizerDeviceId).get();
  if (!subSnap.exists || subSnap.get("premium") !== true) {
    throw new HttpsError("failed-precondition", "Authorizing device does not have an active entitlement.");
  }

  if (authorizerDeviceId !== cameraDeviceId) {
    const paired = await devicesArePaired(authorizerDeviceId, cameraDeviceId);
    if (!paired) {
      throw new HttpsError("permission-denied", "Authorizing device is not paired with the camera.");
    }
  }

  await settingsRef.set(
    {
      detectionAuthorizedBy: authorizerDeviceId,
      detectionAuthorizedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  logger.info(`authorizeDetection: camera=${cameraDeviceId} authorizer=${authorizerDeviceId}`);
  return { authorized: true };
});

export const syncPairingEditors = onDocumentWritten("pairings/{pairingId}", async (event) => {
  const before = event.data?.before;
  const after = event.data?.after;
  const members: string[] = ((after?.exists ? after.get("memberDeviceIds") : before?.get("memberDeviceIds")) ??
    []) as string[];
  if (members.length !== 2) {
    return;
  }

  const isActive = Boolean(after?.exists) && after?.get("status") === "active";
  const [deviceA, deviceB] = members;
  const [ownerA, ownerB] = await Promise.all([deviceOwnerUid(deviceA), deviceOwnerUid(deviceB)]);

  const applyEditor = async (targetDeviceId: string, editorUid: string | undefined) => {
    if (!editorUid) {
      return;
    }
    const value = isActive ? FieldValue.arrayUnion(editorUid) : FieldValue.arrayRemove(editorUid);
    try {
      await db.collection("devices").doc(targetDeviceId).update({ editorUserIds: value });
    } catch (err) {
      logger.warn(`syncPairingEditors: failed to update ${targetDeviceId}`, err);
    }
  };

  await Promise.all([applyEditor(deviceA, ownerB), applyEditor(deviceB, ownerA)]);
  logger.info(
    `syncPairingEditors: ${isActive ? "granted" : "revoked"} editor access between ${deviceA} and ${deviceB}`
  );
});

const FREE_PAIRING_CAP = 2;

export const enforcePairingCap = onDocumentWritten("pairings/{pairingId}", async (event) => {
  const after = event.data?.after;
  if (!after?.exists || after.get("status") !== "active") {
    return;
  }
  const before = event.data?.before;
  if (before?.exists && before.get("status") === "active") {
    return;
  }
  const members: string[] = (after.get("memberDeviceIds") ?? []) as string[];
  for (const deviceId of members) {
    const subSnap = await db.collection("subscriptions").doc(deviceId).get();
    if (subSnap.exists && subSnap.get("premium") === true) {
      continue;
    }
    const active = await db
      .collection("pairings")
      .where("memberDeviceIds", "array-contains", deviceId)
      .where("status", "==", "active")
      .get();
    if (active.size > FREE_PAIRING_CAP) {
      await after.ref.set({ status: "removed" }, { merge: true });
      logger.info(
        `enforcePairingCap: reverted ${event.params.pairingId} — free device ${deviceId} over cap (${active.size})`
      );
      return;
    }
  }
});

export const sweepStaleSessionsScheduled = onSchedule("every 5 minutes", async () => {
  const dryRun = process.env.DRY_RUN !== "false";
  const result = await sweepStaleSessions(db, { dryRun, now: Date.now() });
  logger.info(
    `sweepStaleSessions: dryRun=${dryRun} considered=${result.considered} ` +
      `stale=${result.stale.length} deletedSessions=${result.deletedSessions} ` +
      `deletedConnections=${result.deletedConnections} ` +
      `liveEndedEvents=${result.liveEndedEvents} clearedDevices=${result.clearedDevices}`
  );
  if (result.stale.length > 0) {
    logger.info(`sweepStaleSessions: ids=${result.stale.join(",")}`);
  }
});

function recordToFirestore(record: SubscriptionRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    status: record.status,
    willAutoRenew: record.willAutoRenew,
    isInTrial: record.isInTrial,
    latestEventType: record.latestEventType,
    latestEventAt: Timestamp.fromMillis(record.latestEventAt),
    updatedAt: Timestamp.fromMillis(record.updatedAt),
  };
  const optional: Record<string, number | null> = {
    startAt: record.startAt,
    expiresAt: record.expiresAt,
    gracePeriodExpiresAt: record.gracePeriodExpiresAt,
    premiumExpiresAt: record.premiumExpiresAt,
    cancelledAt: record.cancelledAt,
  };
  for (const [key, value] of Object.entries(optional)) {
    out[key] = value === null ? FieldValue.delete() : Timestamp.fromMillis(value);
  }
  const identity: Record<string, string | null> = {
    cancellationReason: record.cancellationReason,
    originalTransactionId: record.originalTransactionId,
    profileId: record.profileId,
    profileEventId: record.profileEventId,
    transactionId: record.transactionId,
    vendorProductId: record.vendorProductId,
    store: record.store,
    environment: record.environment,
  };
  for (const [key, value] of Object.entries(identity)) {
    out[key] = value === null ? FieldValue.delete() : value;
  }
  return out;
}

async function mirrorPremiumToDevice(deviceId: string, premium: boolean): Promise<boolean> {
  const deviceRef = db.collection("devices").doc(deviceId);
  const snap = await deviceRef.get();
  if (!snap.exists) {
    return false;
  }
  if ((snap.get("premiumActive") === true) === premium) {
    return false;
  }
  await deviceRef.set({ premiumActive: premium }, { merge: true });
  return true;
}

async function applySubscription(
  deviceId: string,
  premium: boolean,
  record: SubscriptionRecord
): Promise<boolean> {
  const subscriptionRef = db.collection("subscriptions").doc(deviceId);
  const applied = await db.runTransaction(async (tx) => {
    const snap = await tx.get(subscriptionRef);
    const storedLatest = snap.exists ? (snap.get("latestEventAt") as Timestamp | undefined) : undefined;
    const storedMs = storedLatest ? storedLatest.toMillis() : undefined;
    const storedEventId = snap.exists ? (snap.get("profileEventId") as string | undefined) : undefined;
    if (!shouldApply(record.profileEventId, record.latestEventAt, storedEventId, storedMs)) {
      return false;
    }
    tx.set(subscriptionRef, { premium, ...recordToFirestore(record) }, { merge: true });
    return true;
  });
  if (applied) {
    await mirrorPremiumToDevice(deviceId, premium);
  }
  return applied;
}

export const adaptySubscriptionWebhook = onRequest({ invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ status: "method_not_allowed" });
    return;
  }
  if (!verifyWebhookSecret(req.get("authorization"), process.env.ADAPTY_WEBHOOK_SECRET)) {
    logger.warn("adaptySubscriptionWebhook: rejected unauthenticated request");
    res.status(401).json({ status: "unauthorized" });
    return;
  }
  const mapped = mapEventToSubscription(req.body as AdaptyWebhookEvent, Date.now());
  if (!mapped.ok) {
    logger.info(`adaptySubscriptionWebhook: ignored (${mapped.reason})`);
    res.status(200).json({ status: "ignored", reason: mapped.reason });
    return;
  }
  try {
    const applied = await applySubscription(
      mapped.value.deviceId,
      mapped.value.premium,
      mapped.value.record
    );
    logger.info(
      `adaptySubscriptionWebhook: device=${mapped.value.deviceId} premium=${mapped.value.premium} applied=${applied}`
    );
    res.status(200).json({ status: "ok", premium: mapped.value.premium, applied });
  } catch (err) {
    logger.error("adaptySubscriptionWebhook: apply failed", err);
    res.status(500).json({ status: "error" });
  }
});

export const reconcileSubscriptions = onSchedule("every 60 minutes", async () => {
  const nowMs = Date.now();
  const snap = await db.collection("subscriptions").where("premium", "==", true).get();
  let flipped = 0;
  let healed = 0;
  for (const doc of snap.docs) {
    const expires = doc.get("premiumExpiresAt") as Timestamp | undefined;
    if (expires && expires.toMillis() <= nowMs) {
      await doc.ref.set(
        {
          premium: false,
          status: "expired",
          updatedAt: Timestamp.fromMillis(nowMs),
        },
        { merge: true }
      );
      await mirrorPremiumToDevice(doc.id, false);
      flipped++;
    } else if (await mirrorPremiumToDevice(doc.id, true)) {
      healed++;
    }
  }
  logger.info(
    `reconcileSubscriptions: ${snap.size} premium devices, flipped ${flipped} expired, healed ${healed} drifted`
  );
});

export const backfillDevicePremium = onDocumentCreated("devices/{deviceId}", async (event) => {
  const snap = event.data;
  if (!snap) {
    return;
  }
  const deviceId = event.params.deviceId;
  const subSnap = await db.collection("subscriptions").doc(deviceId).get();
  const premium = subSnap.exists && subSnap.get("premium") === true;
  if (!premium || snap.get("premiumActive") === true) {
    return;
  }
  await snap.ref.set({ premiumActive: true }, { merge: true });
  logger.info(`backfillDevicePremium: device=${deviceId} premiumActive=true`);
});
