/**
 * OAuth 2.0 + PKCE for MCP servers (e.g. Notion).
 * Tokens are stored as encrypted blobs in thread messages (mcp-oauth), not KV.
 */

export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

/** Payload we encrypt and store in thread as _-# mcp-oauth: <blob>_ */
export interface OAuthPayload {
  mcp_url: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number; // unix ms
  token_endpoint: string;
  client_id: string;
  client_secret?: string;
}

/** Parse WWW-Authenticate for resource_metadata (RFC 9470). Returns URL or undefined. */
export function getResourceMetadataUrlFrom401(
  res: Response,
): string | undefined {
  const ww = res.headers.get("WWW-Authenticate");
  if (!ww || !ww.includes("Bearer")) return undefined;
  const match = ww.match(/resource_metadata\s*=\s*"([^"]+)"/);
  return match ? match[1].trim() : undefined;
}

/** RFC 9470: fetch Protected Resource Metadata, then RFC 8414: Auth Server Metadata. */
export async function discoverOAuthMetadata(
  mcpServerUrl: string,
): Promise<OAuthMetadata> {
  const base = new URL(mcpServerUrl);
  const prmUrl = new URL("/.well-known/oauth-protected-resource", base);
  const prmRes = await fetch(prmUrl.toString());
  if (!prmRes.ok) throw new Error(`PRM fetch failed: ${prmRes.status}`);
  const prm = (await prmRes.json()) as { authorization_servers?: string[] };
  const authServers = prm.authorization_servers;
  if (!Array.isArray(authServers) || authServers.length === 0) {
    throw new Error("No authorization_servers in PRM");
  }
  const asUrl = authServers[0];
  const metaUrl = asUrl.endsWith("/")
    ? `${asUrl}.well-known/oauth-authorization-server`
    : `${asUrl}/.well-known/oauth-authorization-server`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok)
    throw new Error(`Auth server metadata failed: ${metaRes.status}`);
  const meta = (await metaRes.json()) as OAuthMetadata;
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error("Missing authorization_endpoint or token_endpoint");
  }
  return meta;
}

/** Generate PKCE code_verifier and code_challenge (S256). */
export async function generatePKCE(): Promise<{
  code_verifier: string;
  code_challenge: string;
}> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return {
    code_verifier: verifier,
    code_challenge: base64UrlEncode(new Uint8Array(hash)),
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

/** Dynamic Client Registration (RFC 7591). */
export async function registerClient(
  metadata: OAuthMetadata,
  redirectUri: string,
): Promise<{ client_id: string; client_secret?: string }> {
  if (!metadata.registration_endpoint)
    throw new Error("No registration_endpoint");
  const body = {
    client_name: "GroupThink",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    code_challenge_method: "S256",
  };
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DCR failed: ${res.status} ${await res.text()}`);
  const creds = (await res.json()) as {
    client_id: string;
    client_secret?: string;
  };
  return creds;
}

/** Build authorization URL for redirect. */
export function buildAuthorizationUrl(
  metadata: OAuthMetadata,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  scopes: string[] = [],
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (scopes.length) params.set("scope", scopes.join(" "));
  return `${metadata.authorization_endpoint}?${params.toString()}`;
}

/** Exchange code for tokens. */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  metadata: OAuthMetadata,
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  if (clientSecret) params.set("client_secret", clientSecret);
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });
  if (!res.ok)
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return data;
}

/** Refresh access token. Returns new tokens; caller should persist. */
export async function refreshOAuthTokens(
  refreshToken: string,
  metadata: OAuthMetadata,
  clientId: string,
  clientSecret: string | undefined,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) params.set("client_secret", clientSecret);
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });
  if (!res.ok)
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
}

/** Encrypt payload for storage in thread. Key = 32-byte hex (64 chars). */
export async function encryptOAuthPayload(
  payload: OAuthPayload,
  encryptionKeyHex: string,
): Promise<string> {
  const key = hexToBytes(encryptionKeyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    cryptoKey,
    plain,
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...combined))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decrypt blob from thread. Returns null if invalid. */
export async function decryptOAuthPayload(
  blob: string,
  encryptionKeyHex: string,
): Promise<OAuthPayload | null> {
  try {
    const key = hexToBytes(encryptionKeyHex);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const normalized = blob.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4;
    const b64 = pad ? normalized + "=".repeat(4 - pad) : normalized;
    const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      cryptoKey,
      cipher,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as OAuthPayload;
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

/** Pending OAuth state (encrypted in redirect state param; no KV). */
export interface OAuthStatePayload {
  code_verifier: string;
  channel_id: string;
  mcp_url: string;
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  exp: number; // unix ms; reject if past
}

/** Encrypt state payload for OAuth redirect (state param). */
export async function encryptStatePayload(
  payload: OAuthStatePayload,
  encryptionKeyHex: string,
): Promise<string> {
  const key = hexToBytes(encryptionKeyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    cryptoKey,
    plain,
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...combined))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decrypt state param; returns null if invalid or expired. */
export async function decryptStatePayload(
  blob: string,
  encryptionKeyHex: string,
): Promise<OAuthStatePayload | null> {
  try {
    const key = hexToBytes(encryptionKeyHex);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const normalized = blob.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4;
    const b64 = pad ? normalized + "=".repeat(4 - pad) : normalized;
    const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      cryptoKey,
      cipher,
    );
    const payload = JSON.parse(
      new TextDecoder().decode(plain),
    ) as OAuthStatePayload;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
