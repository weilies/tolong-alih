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
 */

const AUTH_COOKIE_PREFIX = "__Secure-neon-auth";
const AUTH_REQUEST_HEADERS = ["user-agent", "authorization", "referer", "content-type"];
const AUTH_RESPONSE_HEADERS = ["content-type", "content-encoding", "date", "set-auth-jwt", "set-auth-token"];
const REST_REQUEST_HEADERS = [
  "authorization", "content-type", "accept", "prefer", "range",
  "accept-profile", "content-profile", "x-neon-client-info",
];
const REST_RESPONSE_HEADERS = ["content-type", "content-range", "preference-applied", "location"];

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

async function proxyRest(request, env, path) {
  const incoming = new URL(request.url);
  const upstream = new URL(`${env.NEON_DATA_API_URL.replace(/\/+$/, "")}/${path}`);
  upstream.search = incoming.search;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const res = await fetch(upstream, {
    method: request.method,
    headers: pick(request.headers, REST_REQUEST_HEADERS),
    body: hasBody ? await request.text() : undefined,
  });

  const out = pick(res.headers, REST_RESPONSE_HEADERS);
  out.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/auth/")) {
      return proxyAuth(request, env, url.pathname.slice("/api/auth/".length));
    }
    if (url.pathname.startsWith("/api/rest/")) {
      return proxyRest(request, env, url.pathname.slice("/api/rest/".length));
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
