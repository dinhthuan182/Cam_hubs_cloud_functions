import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { getIceServers } from "../src/index";

const fn = getIceServers as unknown as {
  run: (request: { auth?: { uid: string }; data: unknown }) => Promise<{
    iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
    ttlSeconds: number;
  }>;
};

async function expectRejection(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, code);
    return true;
  });
}

function configureTurnKey(keyId: string | undefined, apiToken: string | undefined) {
  if (keyId === undefined) delete process.env.CLOUDFLARE_TURN_KEY_ID;
  else process.env.CLOUDFLARE_TURN_KEY_ID = keyId;
  if (apiToken === undefined) delete process.env.CLOUDFLARE_TURN_API_TOKEN;
  else process.env.CLOUDFLARE_TURN_API_TOKEN = apiToken;
}

test("getIceServers rejects unauthenticated callers", async () => {
  configureTurnKey("key", "token");
  await expectRejection(fn.run({ data: {} }), "unauthenticated");
});

test("getIceServers reports unavailable when the TURN key is not configured", async () => {
  configureTurnKey(undefined, undefined);
  await expectRejection(fn.run({ auth: { uid: "u" }, data: {} }), "unavailable");
});

test("getIceServers reports unavailable when Cloudflare rejects the request", async (t) => {
  configureTurnKey("key", "token");
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 503 }));
  await expectRejection(fn.run({ auth: { uid: "u" }, data: {} }), "unavailable");
});

test("getIceServers returns Cloudflare ICE servers to a signed-in caller", async (t) => {
  configureTurnKey("key-1", "token-1");
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478"] },
          { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" },
        ],
      }),
      { status: 201 }
    )
  );

  const result = await fn.run({ auth: { uid: "u" }, data: {} });

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(result.iceServers, [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" },
  ]);
  assert.equal(result.ttlSeconds, 24 * 60 * 60);
});

test.after(() => {
  mock.restoreAll();
  configureTurnKey(undefined, undefined);
});
