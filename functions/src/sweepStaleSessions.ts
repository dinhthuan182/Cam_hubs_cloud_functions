import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";

export const STALE_AFTER_MS = 30_000;

export const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const SWEEP_THRESHOLD_MS = STALE_AFTER_MS * 2;

export const REAPABLE_STATUSES = ["starting", "live", "ending"] as const;
export type ReapableStatus = (typeof REAPABLE_STATUSES)[number];

export interface SessionLike {
  sessionId: string;
  status: string;
  lastHeartbeatAt?: Timestamp;
  startedAt?: Timestamp;
}

interface StaleSessionDetail {
  sessionId: string;
  cameraDeviceId?: string;
  endedAt?: Timestamp;
}

export function isStale(
  session: SessionLike,
  now: number,
  thresholdMs: number = SWEEP_THRESHOLD_MS
): boolean {
  if (!REAPABLE_STATUSES.includes(session.status as ReapableStatus)) return false;
  const reference = session.lastHeartbeatAt ?? session.startedAt;
  if (!reference) return false;
  return now - reference.toMillis() > thresholdMs;
}

export interface SweepResult {
  considered: number;
  stale: string[];
  deletedSessions: number;
  deletedConnections: number;
  liveEndedEvents: number;
  clearedDevices: number;
}

export interface SweepOptions {
  dryRun: boolean;
  now: number;
  thresholdMs?: number;
}

export async function sweepStaleSessions(
  db: Firestore,
  options: SweepOptions
): Promise<SweepResult> {
  const thresholdMs = options.thresholdMs ?? SWEEP_THRESHOLD_MS;
  const snap = await db
    .collection("signalingSessions")
    .where("status", "in", REAPABLE_STATUSES as unknown as string[])
    .get();

  const stale: string[] = [];
  const staleDetails: StaleSessionDetail[] = [];
  for (const doc of snap.docs) {
    const session: SessionLike = {
      sessionId: doc.id,
      status: doc.get("status") as string,
      lastHeartbeatAt: doc.get("lastHeartbeatAt") as Timestamp | undefined,
      startedAt: doc.get("startedAt") as Timestamp | undefined,
    };
    if (isStale(session, options.now, thresholdMs)) {
      stale.push(doc.id);
      staleDetails.push({
        sessionId: doc.id,
        cameraDeviceId: doc.get("cameraDeviceId") as string | undefined,
        endedAt: session.lastHeartbeatAt ?? session.startedAt,
      });
    }
  }

  let deletedSessions = 0;
  let deletedConnections = 0;
  let liveEndedEvents = 0;
  let clearedDevices = 0;
  if (!options.dryRun) {
    for (const detail of staleDetails) {
      const connSnap = await db
        .collection("signalingConnections")
        .where("sessionId", "==", detail.sessionId)
        .get();
      const batch = db.batch();
      for (const c of connSnap.docs) batch.delete(c.ref);
      batch.delete(db.collection("signalingSessions").doc(detail.sessionId));
      if (detail.cameraDeviceId) {
        const endedAt = detail.endedAt ?? Timestamp.fromMillis(options.now);
        batch.set(db.collection("cameraEvents").doc(), {
          cameraDeviceId: detail.cameraDeviceId,
          eventType: "liveEnded",
          detectedAt: endedAt,
          sensitivityLevel: 0,
          sessionId: detail.sessionId,
          endReason: "timeout",
          ttlExpiry: Timestamp.fromMillis(endedAt.toMillis() + RETENTION_WINDOW_MS),
        });
        batch.set(
          db.collection("devices").doc(detail.cameraDeviceId),
          { isStreaming: false },
          { merge: true }
        );
        liveEndedEvents += 1;
        clearedDevices += 1;
      }
      await batch.commit();
      deletedSessions += 1;
      deletedConnections += connSnap.size;
    }
  }

  return {
    considered: snap.size,
    stale,
    deletedSessions,
    deletedConnections,
    liveEndedEvents,
    clearedDevices,
  };
}
