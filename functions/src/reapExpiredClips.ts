import type { Firestore, Query, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { clipStoragePaths } from "./clips";

export const CLIP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const REAPABLE_CLIP_STATES = [
  "recording",
  "uploading",
  "available",
  "unavailable",
] as const;

export const DEFAULT_REAP_LIMIT = 200;

export const DEFAULT_MAX_REAP_PAGES = 10;

export interface ClipBucketFile {
  delete(options: { ignoreNotFound: boolean }): Promise<unknown>;
}

export interface ClipBucket {
  file(path: string): ClipBucketFile;
}

export interface ReapResult {
  considered: number;
  expired: string[];
  skippedFavorites: number;
  deletedObjects: number;
  clearedEvents: number;
  failed: number;
}

export interface ReapOptions {
  dryRun: boolean;
  now: number;
  retentionMs?: number;
  limit?: number;
  maxPages?: number;
}

const CLIP_FIELDS = [
  "clipState",
  "storagePath",
  "thumbnailPath",
  "durationMs",
  "sizeBytes",
  "unavailableReason",
  "favorite",
] as const;

function clearedClipFields(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of CLIP_FIELDS) out[field] = FieldValue.delete();
  return out;
}

export async function reapExpiredClips(
  db: Firestore,
  bucket: ClipBucket,
  options: ReapOptions
): Promise<ReapResult> {
  const retentionMs = options.retentionMs ?? CLIP_RETENTION_MS;
  const limit = options.limit ?? DEFAULT_REAP_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_REAP_PAGES;
  const cutoff = Timestamp.fromMillis(options.now - retentionMs);

  const base = db
    .collection("cameraEvents")
    .where("clipState", "in", REAPABLE_CLIP_STATES as unknown as string[])
    .where("detectedAt", "<", cutoff)
    .orderBy("detectedAt") as unknown as Query;

  const expired: string[] = [];
  let considered = 0;
  let skippedFavorites = 0;
  let deletedObjects = 0;
  let clearedEvents = 0;
  let failed = 0;
  let cursor: QueryDocumentSnapshot | undefined;

  for (let page = 0; page < maxPages && expired.length < limit; page += 1) {
    const paged = cursor ? base.startAfter(cursor).limit(limit) : base.limit(limit);
    const snap = await paged.get();
    if (snap.docs.length === 0) break;

    considered += snap.docs.length;
    cursor = snap.docs[snap.docs.length - 1];

    for (const doc of snap.docs) {
      if (expired.length >= limit) break;

      if (doc.get("favorite") === true) {
        skippedFavorites += 1;
        continue;
      }

      expired.push(doc.id);
      if (options.dryRun) continue;

      const cameraDeviceId = doc.get("cameraDeviceId") as string | undefined;
      try {
        if (cameraDeviceId) {
          const paths = clipStoragePaths(cameraDeviceId, doc.id);
          await Promise.all([
            bucket.file(paths.clip).delete({ ignoreNotFound: true }),
            bucket.file(paths.thumb).delete({ ignoreNotFound: true }),
          ]);
          deletedObjects += 2;
        }
        await doc.ref.update(clearedClipFields());
        clearedEvents += 1;
      } catch {
        failed += 1;
      }
    }

    if (snap.docs.length < limit) break;
  }

  return {
    considered,
    expired,
    skippedFavorites,
    deletedObjects,
    clearedEvents,
    failed,
  };
}
