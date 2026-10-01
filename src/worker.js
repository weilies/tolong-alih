/**
 * Tolong Alih — asset worker.
 *
 * Static assets are served straight from ./public. The script exists for three
 * things the static file cannot do on its own:
 *
 *   /config.js    per-environment values from wrangler vars. The app is a
 *                 single HTML file with no build step, so they have nowhere
 *                 else to be baked in.
 *   /api/auth/*   Neon Auth, proxied. Its session is a cookie, and a cookie set
 *                 by *.neon.tech is third-party to this page — iOS Safari drops
 *                 it and the driver is signed out on every load. Served from
 *                 our own origin it is first-party. Mirrors the proxy in
 *                 @neondatabase/auth/next.
 *   /api/rest/*   Neon Data API, proxied. Not needed for cookies (it takes a
 *                 bearer JWT), but it keeps CORS and the CSP to 'self'.
 *                 After a verb that writes a message, the worker also sends
 *                 the Web Push for it (src/push.js) — Neon has nothing that
 *                 can make an outbound call, so this is where it has to live.
 *   /api/push/test  sends a test notification to the caller's own devices.
 */

import { drainKey, sendPush } from "./push.js";

const AUTH_COOKIE_PREFIX = "__Secure-neon-auth";
const AUTH_REQUEST_HEADERS = ["user-agent", "authorization", "referer", "content-type"];
const AUTH_RESPONSE_HEADERS = ["content-type", "content-encoding", "date", "set-auth-jwt", "set-auth-token"];
const REST_REQUEST_HEADERS = [
  "authorization", "content-type", "accept", "prefer", "range",
  "accept-profile", "content-profile", "x-neon-client-info",
];
const REST_RESPONSE_HEADERS = ["content-type", "content-range", "preference-applied", "location"];
// The verbs that leave a message for the other driver: each one is a push.
const TEST_DELAY_MS = 10000;
const PUSH_VERBS = new Set(["declare_block", "clear_block", "flag_block", "contact_blocker", "say"]);

function pick(from, names, into = new Headers()) {
  for (const name of names) {
    const value = from.get(name);
    if (value) into.set(name, value);
  }
  return into;
}

// Upstream is cross-site, so it sets SameSite=None; Partitioned. Once the
// cookie is ours it is first-party: Lax, host-only, never partitioned.
function firstParty(setCookie) {
  return setCookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !/^(domain|samesite|partitioned|secure)(=|$)/i.test(part))
    .concat(["Secure", "SameSite=Lax"])
    .join("; ");
}

async function proxyAuth(request, env, path) {
  const incoming = new URL(request.url);
  const upstream = new URL(`${env.NEON_AUTH_URL.replace(/\/+$/, "")}/${path}`);
  upstream.search = incoming.search;

  const headers = pick(request.headers, AUTH_REQUEST_HEADERS);
  headers.set("origin", request.headers.get("origin") || incoming.origin);
  headers.set("x-neon-auth-middleware", "true");
  const cookies = (request.headers.get("cookie") || "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.startsWith(AUTH_COOKIE_PREFIX));
  if (cookies.length) headers.set("cookie", cookies.join("; "));

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const res = await fetch(upstream, {
    method: request.method,
    headers,
    body: hasBody ? await request.text() : undefined,
    redirect: "manual",
  });

  const out = pick(res.headers, AUTH_RESPONSE_HEADERS);
  for (const c of res.headers.getSetCookie()) out.append("set-cookie", firstParty(c));
  const location = res.headers.get("location");
  if (location) out.set("location", location);
  out.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

function pushReady(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function rpc(env, fn, args, authorization) {
  const headers = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  return fetch(`${env.NEON_DATA_API_URL.replace(/\/+$/, "")}/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
}

// Push each device its notification; forget the ones the push service says are gone.
async function deliver(env, rows, message) {
  const gone = [];
  let sent = 0;
  await Promise.all(rows.map(async (row) => {
    try {
      const status = await sendPush(env, row, message(row), {
        topic: row.block_id ? row.block_id.replace(/-/g, "") : undefined,
      });
      if (status === 404 || status === 410) gone.push(row.endpoint);
      else if (status >= 400) console.error("push rejected", status, new URL(row.endpoint).host);
      else sent++;
    } catch (e) {
      console.error("push failed", e);
    }
  }));
  return { sent, gone };
}

// Called after every verb. Claims whatever messages are unsent — this one and
// any a previous run dropped — so a lost push is retried by the next verb.
//
// `authorization` is the bearer token of the driver whose verb triggered this.
// Neon's Data API refuses any request without a JWT, whatever the anonymous
// role allows, so the worker borrows the caller's. push_drain is granted to
// `authenticated` and still gated on the worker's key, so a driver's token
// alone gets nothing.
async function drainPush(env, authorization) {
  if (!pushReady(env)) return;
  const key = await drainKey(env);
  const res = await rpc(env, "push_drain", { p_key: key }, authorization);
  if (!res.ok) return console.error("push_drain", res.status, await res.text());
  const rows = await res.json();
  if (!rows.length) return;
  const { gone } = await deliver(env, rows, (r) => ({
    title: r.title, body: r.body, tag: r.block_id, kind: r.kind, url: "/",
  }));
  if (gone.length) await rpc(env, "push_gone", { p_key: key, p_endpoints: gone }, authorization);
}

async function pushTest(request, env, ctx) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!pushReady(env)) return json(503, { error: "Push is not set up on this server yet." });

  const res = await rpc(env, "push_mine", {}, request.headers.get("authorization"));
  if (!res.ok) return json(res.status, { error: "Sign in first." });
  const rows = await res.json();
  // Sent after a pause, so a driver testing alone has time to lock the phone.
  ctx.waitUntil(new Promise((r) => setTimeout(r, TEST_DELAY_MS)).then(async () => {
    const { gone } = await deliver(env, rows, () => ({
      title: "Blocked in (test)", body: "TEST 999 is parked behind your car. This is what a real alert looks like.",
      tag: "test", kind: "hot", url: "/",
    }));
    if (gone.length) {
      await rpc(env, "push_gone", { p_key: await drainKey(env), p_endpoints: gone }, request.headers.get("authorization"));
    }
  }));
  return json(200, { devices: rows.length, delay: TEST_DELAY_MS / 1000 });
}

async function proxyRest(request, env, ctx, path) {
  const incoming = new URL(request.url);
  const upstream = new URL(`${env.NEON_DATA_API_URL.replace(/\/+$/, "")}/${path}`);
  upstream.search = incoming.search;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const res = await fetch(upstream, {
    method: request.method,
    headers: pick(request.headers, REST_REQUEST_HEADERS),
    body: hasBody ? await request.text() : undefined,
  });

  if (res.ok && request.method === "POST" && PUSH_VERBS.has(path.replace(/^rpc\//, ""))) {
    const authorization = request.headers.get("authorization");
    ctx.waitUntil(drainPush(env, authorization).catch((e) => console.error("drainPush", e)));
  }

  const out = pick(res.headers, REST_RESPONSE_HEADERS);
  out.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/auth/")) {
      return proxyAuth(request, env, url.pathname.slice("/api/auth/".length));
    }
    if (url.pathname.startsWith("/api/rest/")) {
      return proxyRest(request, env, ctx, url.pathname.slice("/api/rest/".length));
    }
    if (url.pathname === "/api/push/test") {
      return pushTest(request, env, ctx);
    }

    if (url.pathname === "/config.js") {
      // Cloudflare already resolved the request's country and city from the IP.
      // It costs nothing extra and covers the case the gate cares about most:
      // GPS refused or unavailable indoors, where we still need to know whether
      // the driver is in Malaysia.
      const cf = request.cf || {};
      const config = {
        env: env.APP_ENV,
        authUrl: `${url.origin}/api/auth`,
        dataApiUrl: `${url.origin}/api/rest`,
        // Only offered once the server can actually send.
        vapidPublicKey: pushReady(env) ? env.VAPID_PUBLIC_KEY : null,
        ip: {
          country: cf.country || null,
          city: cf.city || null,
          region: cf.region || null,
        },
      };
      return new Response(`window.__ENV=${JSON.stringify(config)};`, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
