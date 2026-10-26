export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export const ICE_SERVER_TTL_SECONDS = 24 * 60 * 60;

const CLOUDFLARE_TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

function isPort53(url: string): boolean {
  return /:53(\?|$)/.test(url);
}

function normalize(entry: unknown): IceServer | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const raw = entry as Record<string, unknown>;
  const rawUrls = Array.isArray(raw.urls) ? raw.urls : [raw.urls];
  const urls = rawUrls.filter((u): u is string => typeof u === "string" && !isPort53(u));
  if (urls.length === 0) return undefined;
  const server: IceServer = { urls };
  if (typeof raw.username === "string") server.username = raw.username;
  if (typeof raw.credential === "string") server.credential = raw.credential;
  return server;
}

export async function generateCloudflareIceServers(
  keyId: string | undefined,
  apiToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
  ttlSeconds: number = ICE_SERVER_TTL_SECONDS
): Promise<IceServer[]> {
  if (!keyId || !apiToken) {
    throw new Error("Cloudflare TURN key is not configured.");
  }
  const response = await fetchImpl(
    `${CLOUDFLARE_TURN_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: ttlSeconds }),
    }
  );
  if (!response.ok) {
    throw new Error(`Cloudflare TURN responded ${response.status}.`);
  }
  const body = (await response.json()) as { iceServers?: unknown };
  const entries = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
  const servers = entries.map(normalize).filter((s): s is IceServer => s !== undefined);
  if (servers.length === 0) {
    throw new Error("Cloudflare TURN returned no usable ICE servers.");
  }
  return servers;
}
