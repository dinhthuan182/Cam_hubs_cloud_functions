import assert from "node:assert";
import { test } from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import {
  reapExpiredClips,
  CLIP_RETENTION_MS,
  REAPABLE_CLIP_STATES,
  type ClipBucket,
} from "../src/reapExpiredClips";

interface UpdateOp {
  path: string;
  fields: string[];
}

interface FakeDoc {
  id: string;
  ref: { path: string; update(data: Record<string, unknown>): Promise<void> };
  get(field: string): unknown;
}

function eventDoc(
  id: string,
  fields: Record<string, unknown>,
  sink: UpdateOp[],
  failUpdate = false
): FakeDoc {
  return {
    id,
    ref: {
      path: `cameraEvents/${id}`,
      async update(data: Record<string, unknown>) {
        if (failUpdate) throw new Error("update failed");
        sink.push({ path: `cameraEvents/${id}`, fields: Object.keys(data) });
      },
    },
    get: (f) => fields[f],
  };
}

function fakeDb(events: FakeDoc[]): Firestore {
  const collection = (name: string) => {
    const filters: Array<{ field: string; op: string; val: unknown }> = [];
    let cap = Number.MAX_SAFE_INTEGER;
    let after: string | undefined;
    const api = {
      where(field: string, op: string, val: unknown) {
        filters.push({ field, op, val });
        return api;
      },
      orderBy() {
        return api;
      },
      startAfter(doc: FakeDoc) {
        after = doc.id;
        return api;
      },
      limit(n: number) {
        cap = n;
        return api;
      },
      async get() {
        let docs = name === "cameraEvents" ? events : [];
        for (const f of filters) {
          docs = docs.filter((d) => {
            const v = d.get(f.field);
            if (f.op === "in") return (f.val as unknown[]).includes(v);
            if (f.op === "<") return (v as Timestamp).toMillis() < (f.val as Timestamp).toMillis();
            return true;
          });
        }
        if (after !== undefined) {
          const at = docs.findIndex((d) => d.id === after);
          docs = at < 0 ? [] : docs.slice(at + 1);
        }
        docs = docs.slice(0, cap);
        return { docs, size: docs.length };
      },
    };
    return api;
  };
  return { collection } as unknown as Firestore;
}

function fakeBucket(deleted: string[], failPaths: string[] = []): ClipBucket {
  return {
    file(path: string) {
      return {
        async delete() {
          if (failPaths.includes(path)) throw new Error("storage failure");
          deleted.push(path);
          return undefined;
        },
      };
    },
  };
}

const NOW = 1_700_000_000_000;
const EXPIRED = Timestamp.fromMillis(NOW - (CLIP_RETENTION_MS + 60_000));
const FRESH = Timestamp.fromMillis(NOW - 60_000);

test("an expired clip has both objects deleted and its clip fields cleared", async () => {
  const updates: UpdateOp[] = [];
  const deleted: string[] = [];
  const events = [
    eventDoc(
      "evt-old",
      { clipState: "available", detectedAt: EXPIRED, cameraDeviceId: "cam-1" },
      updates
    ),
    eventDoc(
      "evt-new",
      { clipState: "available", detectedAt: FRESH, cameraDeviceId: "cam-1" },
      updates
    ),
  ];

  const result = await reapExpiredClips(fakeDb(events), fakeBucket(deleted), {
    dryRun: false,
    now: NOW,
  });

  assert.deepEqual(result.expired, ["evt-old"]);
  assert.equal(result.clearedEvents, 1);
  assert.equal(result.deletedObjects, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(deleted, ["clips/cam-1/evt-old.mp4", "clips/cam-1/evt-old_thumb.jpg"]);
  assert.deepEqual(updates.map((u) => u.path), ["cameraEvents/evt-old"]);
});

test("clearing removes every clip field so the doc drops out of the query", async () => {
  const updates: UpdateOp[] = [];
  const events = [
    eventDoc(
      "evt-old",
      { clipState: "available", detectedAt: EXPIRED, cameraDeviceId: "cam-1" },
      updates
    ),
  ];

  await reapExpiredClips(fakeDb(events), fakeBucket([]), { dryRun: false, now: NOW });

  assert.deepEqual(updates[0].fields.sort(), [
    "clipState",
    "durationMs",
    "favorite",
    "sizeBytes",
    "storagePath",
    "thumbnailPath",
    "unavailableReason",
  ]);
});

test("clips the client already marked unavailable are still reclaimed", async () => {
  const updates: UpdateOp[] = [];
  const deleted: string[] = [];
  const events = [
    eventDoc(
      "evt-pruned",
      {
        clipState: "unavailable",
        unavailableReason: "pruned",
        detectedAt: EXPIRED,
        cameraDeviceId: "cam-2",
      },
      updates
    ),
  ];

  const result = await reapExpiredClips(fakeDb(events), fakeBucket(deleted), {
    dryRun: false,
    now: NOW,
  });

  assert.equal(result.clearedEvents, 1);
  assert.deepEqual(deleted, ["clips/cam-2/evt-pruned.mp4", "clips/cam-2/evt-pruned_thumb.jpg"]);
});

test("every reapable state implies media that may still be in the bucket", () => {
  assert.deepEqual([...REAPABLE_CLIP_STATES], [
    "recording",
    "uploading",
    "available",
    "unavailable",
  ]);
});

test("dry-run reports candidates but touches nothing", async () => {
  const updates: UpdateOp[] = [];
  const deleted: string[] = [];
  const events = [
    eventDoc(
      "evt-old",
      { clipState: "available", detectedAt: EXPIRED, cameraDeviceId: "cam-1" },
      updates
    ),
  ];

  const result = await reapExpiredClips(fakeDb(events), fakeBucket(deleted), {
    dryRun: true,
    now: NOW,
  });

  assert.deepEqual(result.expired, ["evt-old"]);
  assert.equal(result.considered, 1);
  assert.equal(result.clearedEvents, 0);
  assert.equal(result.deletedObjects, 0);
  assert.deepEqual(deleted, []);
  assert.deepEqual(updates, []);
});

test("a Storage failure is counted and does not abort the run", async () => {
  const updates: UpdateOp[] = [];
  const deleted: string[] = [];
  const events = [
    eventDoc(
      "evt-bad",
      { clipState: "available", detectedAt: EXPIRED, cameraDeviceId: "cam-1" },
      updates
    ),
    eventDoc(
      "evt-good",
      { clipState: "available", detectedAt: EXPIRED, cameraDeviceId: "cam-1" },
      updates
    ),
  ];

  const result = await reapExpiredClips(
    fakeDb(events),
    fakeBucket(deleted, ["clips/cam-1/evt-bad.mp4"]),
    { dryRun: false, now: NOW }
  );

  assert.equal(result.failed, 1);
  assert.equal(result.clearedEvents, 1);
  assert.deepEqual(updates.map((u) => u.path), ["cameraEvents/evt-good"]);
});

test("an event with no cameraDeviceId still has its clip fields cleared", async () => {
  const updates: UpdateOp[] = [];
  const deleted: string[] = [];
  const events = [eventDoc("evt-orphan", { clipState: "available", detectedAt: EXPIRED }, updates)];

  const result = await reapExpiredClips(fakeDb(events), fakeBucket(deleted), {
    dryRun: false,
    now: NOW,
  });

  assert.equal(result.clearedEvents, 1);
  assert.equal(result.deletedObjects, 0);
  assert.deepEqual(deleted, []);
});

test("a favorited clip keeps its media however old it is", async () => {
  const updates: UpdateOp[] = [];
  const deleted: string[] = [];
  const events = [
    eventDoc(
      "evt-pinned",
      {
        clipState: "available",
        detectedAt: EXPIRED,
        cameraDeviceId: "cam-1",
        favorite: true,
      },
      updates
    ),
    eventDoc(
      "evt-plain",
      { clipState: "available", detectedAt: EXPIRED, cameraDeviceId: "cam-1" },
      updates
    ),
  ];

  const result = await reapExpiredClips(fakeDb(events), fakeBucket(deleted), {
    dryRun: false,
    now: NOW,
  });

  assert.deepEqual(result.expired, ["evt-plain"]);
  assert.equal(result.skippedFavorites, 1);
  assert.deepEqual(deleted, ["clips/cam-1/evt-plain.mp4", "clips/cam-1/evt-plain_thumb.jpg"]);
  assert.deepEqual(updates.map((u) => u.path), ["cameraEvents/evt-plain"]);
});

test("favorites never dropped by the query cannot starve later clips", async () => {
  const updates: UpdateOp[] = [];
  const deleted: string[] = [];
  const events = [
    ...Array.from({ length: 4 }, (_, i) =>
      eventDoc(
        `fav-${i}`,
        {
          clipState: "available",
          detectedAt: EXPIRED,
          cameraDeviceId: "cam-1",
          favorite: true,
        },
        updates
      )
    ),
    eventDoc(
      "evt-reapable",
      { clipState: "available", detectedAt: EXPIRED, cameraDeviceId: "cam-1" },
      updates
    ),
  ];

  const result = await reapExpiredClips(fakeDb(events), fakeBucket(deleted), {
    dryRun: false,
    now: NOW,
    limit: 2,
  });

  assert.deepEqual(result.expired, ["evt-reapable"]);
  assert.equal(result.skippedFavorites, 4);
  assert.equal(result.clearedEvents, 1);
});

test("the batch limit bounds a single run", async () => {
  const updates: UpdateOp[] = [];
  const events = Array.from({ length: 5 }, (_, i) =>
    eventDoc(
      `evt-${i}`,
      { clipState: "available", detectedAt: EXPIRED, cameraDeviceId: "cam-1" },
      updates
    )
  );

  const result = await reapExpiredClips(fakeDb(events), fakeBucket([]), {
    dryRun: false,
    now: NOW,
    limit: 2,
  });

  assert.equal(result.considered, 2);
  assert.equal(result.clearedEvents, 2);
});
