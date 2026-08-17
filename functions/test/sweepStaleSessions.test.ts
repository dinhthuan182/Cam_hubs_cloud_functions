import assert from "node:assert";
import { test } from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import {
  sweepStaleSessions,
  SWEEP_THRESHOLD_MS,
  RETENTION_WINDOW_MS,
} from "../src/sweepStaleSessions";

interface WriteOp {
  type: "set" | "delete";
  path: string;
  data?: Record<string, unknown>;
  merge?: boolean;
}

interface FakeDoc {
  id: string;
  ref: { path: string };
  get(field: string): unknown;
}

function sessionDoc(id: string, fields: Record<string, unknown>): FakeDoc {
  return { id, ref: { path: `signalingSessions/${id}` }, get: (f) => fields[f] };
}

function fakeDb(sessions: FakeDoc[], sink: WriteOp[]): Firestore {
  const autoId = { n: 0 };
  const collection = (name: string) => {
    const filters: Array<{ field: string; op: string; val: unknown }> = [];
    const api = {
      where(field: string, op: string, val: unknown) {
        filters.push({ field, op, val });
        return api;
      },
      async get() {
        let docs = name === "signalingSessions" ? sessions : [];
        for (const f of filters) {
          docs = docs.filter((d) => {
            const v = d.get(f.field);
            if (f.op === "in") return (f.val as unknown[]).includes(v);
            if (f.op === "==") return v === f.val;
            return true;
          });
        }
        return { docs, size: docs.length };
      },
      doc(id?: string) {
        const realId = id ?? `auto-${autoId.n++}`;
        return { path: `${name}/${realId}`, id: realId };
      },
    };
    return api;
  };
  const batch = () => {
    const ops: WriteOp[] = [];
    return {
      delete(ref: { path: string }) {
        ops.push({ type: "delete", path: ref.path });
      },
      set(ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) {
        ops.push({ type: "set", path: ref.path, data, merge: opts?.merge });
      },
      async commit() {
        for (const op of ops) sink.push(op);
      },
    };
  };
  return { collection, batch } as unknown as Firestore;
}

const NOW = 1_700_000_000_000;

test("a stale live session writes a liveEnded event and clears isStreaming", async () => {
  const heartbeat = Timestamp.fromMillis(NOW - (SWEEP_THRESHOLD_MS + 10_000));
  const sessions = [
    sessionDoc("s1", {
      status: "live",
      cameraDeviceId: "cam-1",
      lastHeartbeatAt: heartbeat,
      startedAt: Timestamp.fromMillis(NOW - 600_000),
    }),
    sessionDoc("fresh", {
      status: "live",
      cameraDeviceId: "cam-2",
      lastHeartbeatAt: Timestamp.fromMillis(NOW),
      startedAt: Timestamp.fromMillis(NOW - 10_000),
    }),
  ];
  const sink: WriteOp[] = [];
  const result = await sweepStaleSessions(fakeDb(sessions, sink), { dryRun: false, now: NOW });

  assert.deepEqual(result.stale, ["s1"]);
  assert.equal(result.deletedSessions, 1);
  assert.equal(result.liveEndedEvents, 1);
  assert.equal(result.clearedDevices, 1);

  const liveEnded = sink.find((op) => op.path.startsWith("cameraEvents/"));
  assert.ok(liveEnded, "expected a cameraEvents write");
  assert.equal(liveEnded.data?.eventType, "liveEnded");
  assert.equal(liveEnded.data?.sessionId, "s1");
  assert.equal(liveEnded.data?.cameraDeviceId, "cam-1");
  assert.equal(liveEnded.data?.endReason, "timeout");
  assert.equal((liveEnded.data?.detectedAt as Timestamp).toMillis(), heartbeat.toMillis());
  assert.equal(
    (liveEnded.data?.ttlExpiry as Timestamp).toMillis(),
    heartbeat.toMillis() + RETENTION_WINDOW_MS
  );

  const deviceClear = sink.find((op) => op.path === "devices/cam-1");
  assert.ok(deviceClear, "expected a devices write");
  assert.equal(deviceClear.data?.isStreaming, false);
  assert.equal(deviceClear.merge, true);

  assert.ok(sink.some((op) => op.type === "delete" && op.path === "signalingSessions/s1"));
});

test("dry-run writes nothing", async () => {
  const sessions = [
    sessionDoc("s1", {
      status: "live",
      cameraDeviceId: "cam-1",
      lastHeartbeatAt: Timestamp.fromMillis(NOW - (SWEEP_THRESHOLD_MS + 10_000)),
    }),
  ];
  const sink: WriteOp[] = [];
  const result = await sweepStaleSessions(fakeDb(sessions, sink), { dryRun: true, now: NOW });

  assert.deepEqual(result.stale, ["s1"]);
  assert.equal(result.liveEndedEvents, 0);
  assert.equal(result.clearedDevices, 0);
  assert.equal(sink.length, 0);
});

test("a stale session without a cameraDeviceId is still reaped but writes no liveEnded", async () => {
  const sessions = [
    sessionDoc("s1", {
      status: "live",
      lastHeartbeatAt: Timestamp.fromMillis(NOW - (SWEEP_THRESHOLD_MS + 10_000)),
    }),
  ];
  const sink: WriteOp[] = [];
  const result = await sweepStaleSessions(fakeDb(sessions, sink), { dryRun: false, now: NOW });

  assert.equal(result.deletedSessions, 1);
  assert.equal(result.liveEndedEvents, 0);
  assert.equal(result.clearedDevices, 0);
  assert.ok(!sink.some((op) => op.path.startsWith("cameraEvents/")));
});
