/**
 * Web Push, by hand, on WebCrypto. No npm package: the two RFCs are small and
 * the web-push libraries all reach for Node's crypto, which a Worker lacks.
 *
 *   RFC 8292  VAPID — an ES256 JWT that proves the push came from us.
 *   RFC 8291  payload encryption (aes128gcm) to the browser's own key.
 *
 * Keys: VAPID_PUBLIC_KEY (wrangler var, also served to the page) and
 * VAPID_PRIVATE_KEY (wrangler secret, the raw 32-byte scalar). Both base64url.
 * `node scripts/vapid.mjs` makes a pair.
 */

const enc = new TextEncoder();

export function b64u(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// HKDF with a single output block, which is all 8291 ever needs (<= 32 bytes).
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** The key the database checks before it hands the worker anyone's endpoint. */
export async function drainKey(env) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode("tolong-alih push:" + env.VAPID_PRIVATE_KEY));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const jwtCache = new Map(); // audience -> { jwt, exp }

async function vapidJwt(env, audience) {
  const now = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(audience);
  if (hit && hit.exp - now > 3600) return hit.jwt;

  const pub = unb64u(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const exp = now + 12 * 3600;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: audience, exp, sub: env.VAPID_SUBJECT })));
  // WebCrypto's ECDSA output is already r||s, which is what JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  const jwt = `${head}.${body}.${b64u(sig)}`;
  jwtCache.set(audience, { jwt, exp });
  return jwt;
}

/** RFC 8291 §3–4: one aes128gcm record addressed to the browser's key. */
export async function encrypt(sub, plaintext, salt = crypto.getRandomValues(new Uint8Array(16)), local) {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);

  local ||= await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02: last and only record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));

  const rs = new Uint8Array([0, 0, 16, 0]); // 4096, big-endian
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/**
 * Sends one notification. Resolves to the push service's status: 201 is
 * delivered-to-queue, 404/410 mean the subscription is dead and should go.
 */
export async function sendPush(env, sub, message, { ttl = 600, topic } = {}) {
  const endpoint = new URL(sub.endpoint);
  const jwt = await vapidJwt(env, endpoint.origin);
  const body = await encrypt(sub, enc.encode(JSON.stringify(message)));
  const headers = {
    authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(ttl),
    urgency: "high",
  };
  // A newer push for the same block replaces an undelivered older one.
  if (topic) headers.topic = topic;
  const res = await fetch(sub.endpoint, { method: "POST", headers, body });
  return res.status;
}
