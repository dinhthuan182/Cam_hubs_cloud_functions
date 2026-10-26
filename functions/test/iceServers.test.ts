import { test } from "node:test";
import assert from "node:assert/strict";
import { ICE_SERVER_TTL_SECONDS, generateCloudflareIceServers } from "../src/iceServers";

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(status: number, body: unknown) {
  const requests: CapturedRequest[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, requests };
}

const cloudflareResponse = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "user-1",
      credential: "pass-1",
    },
  ],
};

test("an unconfigured TURN key fails closed without calling Cloudflare", async () => {
  const { impl, requests } = fakeFetch(201, cloudflareResponse);
  await assert.rejects(generateCloudflareIceServers(undefined, "token", impl));
  await assert.rejects(generateCloudflareIceServers("key", "", impl));
  assert.equal(requests.length, 0);
});

test("credentials are requested for the configured key with the bearer token and TTL", async () => {
  const { impl, requests } = fakeFetch(201, cloudflareResponse);
  await generateCloudflareIceServers("key-123", "token-abc", impl);

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers"
  );
  assert.equal(requests[0].init?.method, "POST");
  const headers = new Headers(requests[0].init?.headers);
  assert.equal(headers.get("authorization"), "Bearer token-abc");
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { ttl: ICE_SERVER_TTL_SECONDS });
});

test("the TTL outlives a 45 minute client cache", () => {
  assert.ok(ICE_SERVER_TTL_SECONDS > 45 * 60);
});

test("STUN and TURN entries are returned without port 53 URLs", async () => {
  const { impl } = fakeFetch(201, cloudflareResponse);
  const servers = await generateCloudflareIceServers("key", "token", impl);

  assert.deepEqual(servers, [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "user-1",
      credential: "pass-1",
    },
  ]);
});

test("a single iceServers object is accepted", async () => {
  const { impl } = fakeFetch(201, {
    iceServers: { urls: "turn:turn.cloudflare.com:3478?transport=udp", username: "u", credential: "c" },
  });
  const servers = await generateCloudflareIceServers("key", "token", impl);

  assert.deepEqual(servers, [
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "c" },
  ]);
});

test("a non-2xx Cloudflare response is an error", async () => {
  const { impl } = fakeFetch(401, { error: "unauthorized" });
  await assert.rejects(generateCloudflareIceServers("key", "token", impl));
});

test("a response without usable servers is an error", async () => {
  const { impl } = fakeFetch(201, { iceServers: [{ urls: ["stun:stun.cloudflare.com:53"] }] });
  await assert.rejects(generateCloudflareIceServers("key", "token", impl));
});
