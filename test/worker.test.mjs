// The worker's own behaviour, with fetch stubbed: `node --test test/`.
// What breaks quietly if it regresses — the iOS auth cookie, which env the page
// is told it is in, and whether a verb wakes the push sender.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const ENV = {
  APP_ENV: "uat",
  NEON_AUTH_URL: "https://auth.example.neon.tech/neondb/auth/",
  NEON_DATA_API_URL: "https://rest.example.neon.tech/neondb/rest/v1",
  ASSETS: { fetch: async () => new Response("asset") },
};

function ctx() {
  const waits = [];
  return { waits, waitUntil: (p) => waits.push(p) };
}

function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("/config.js reports the env, same-origin API urls, and hides push without keys", async () => {
  const res = await worker.fetch(new Request("https://uat.alih.nextnovas.com/config.js"), ENV, ctx());
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.text();
  const cfg = JSON.parse(body.replace(/^window\.__ENV=/, "").replace(/;$/, ""));
  assert.equal(cfg.env, "uat");
  assert.equal(cfg.authUrl, "https://uat.alih.nextnovas.com/api/auth");
  assert.equal(cfg.dataApiUrl, "https://uat.alih.nextnovas.com/api/rest");
  assert.equal(cfg.vapidPublicKey, null);
  assert.equal(cfg.release, "dev", "no RELEASE var means a local build");
});

test("/config.js passes through the release the deploy stamped", async () => {
  const env = { ...ENV, RELEASE: "uat-2026.10.01-30", COMMIT: "abc1234def" };
  const body = await (await worker.fetch(new Request("https://x/config.js"), env, ctx())).text();
  assert.match(body, /"release":"uat-2026.10.01-30"/);
  assert.match(body, /"commit":"abc1234def"/);
});

test("/config.js offers the VAPID public key only when both halves are set", async () => {
  const env = { ...ENV, VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" };
  const body = await (await worker.fetch(new Request("https://x/config.js"), env, ctx())).text();
  assert.match(body, /"vapidPublicKey":"pub"/);
  assert.doesNotMatch(body, /priv/);
});

test("auth proxy forwards only Neon Auth cookies and makes Set-Cookie first-party", async () => {
  const f = stubFetch(() => {
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", "__Secure-neon-auth.session=abc; Domain=neon.tech; Path=/; SameSite=None; Secure; Partitioned; HttpOnly");
    return new Response("{}", { status: 200, headers: h });
  });
  try {
    const req = new Request("https://alih.nextnovas.com/api/auth/get-session?x=1", {
      headers: { cookie: "__Secure-neon-auth.session=abc; _ga=tracking; other=1" },
    });
    const res = await worker.fetch(req, ENV, ctx());
    assert.equal(f.calls[0].url, "https://auth.example.neon.tech/neondb/auth/get-session?x=1");
    assert.equal(f.calls[0].init.headers.get("cookie"), "__Secure-neon-auth.session=abc");
    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.doesNotMatch(cookie, /Domain=|Partitioned|SameSite=None/i);
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally { f.restore(); }
});

test("rest proxy: a verb RPC wakes the push drain, a plain read does not", async () => {
  const env = { ...ENV, VAPID_PUBLIC_KEY: "BPub", VAPID_PRIVATE_KEY: "AAAA" };
  const f = stubFetch((url) => {
    if (url.endsWith("/rpc/push_drain")) return new Response("[]", { status: 200 });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const c1 = ctx();
    await worker.fetch(new Request("https://x/api/rest/rpc/declare_block", {
      method: "POST", body: "{}", headers: { authorization: "Bearer t", cookie: "x=1" },
    }), env, c1);
    assert.equal(f.calls[0].url, "https://rest.example.neon.tech/neondb/rest/v1/rpc/declare_block");
    assert.equal(f.calls[0].init.headers.get("cookie"), null, "cookies never reach the Data API");
    assert.equal(c1.waits.length, 1, "declare_block schedules a push drain");
    await Promise.all(c1.waits);
    const drain = f.calls.find((c) => c.url.endsWith("/rpc/push_drain"));
    assert.ok(drain, "push_drain was called");
    // Neon rejects requests with no JWT, so the drain must carry the caller's.
    assert.equal(drain.init.headers.authorization, "Bearer t");

    const c2 = ctx();
    await worker.fetch(new Request("https://x/api/rest/cars?select=id"), env, c2);
    assert.equal(c2.waits.length, 0, "a read does not drain");
  } finally { f.restore(); }
});

test("everything else is a static asset", async () => {
  const res = await worker.fetch(new Request("https://x/index.html"), ENV, ctx());
  assert.equal(await res.text(), "asset");
});

// ---- Help page stats: Neon answers nobody without a token ----

function fakeCaches() {
  const store = new Map();
  const real = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async (k) => { const r = store.get(k); return r ? r.clone() : undefined; },
      put: async (k, r) => { store.set(k, r); },
    },
  };
  return { store, restore: () => { if (real === undefined) delete globalThis.caches; else globalThis.caches = real; } };
}

const STATS = { drivers: 12, plates: 15, declared: 40, resolved: 31, mau: 9 };

test("/api/stats is null until a driver has warmed the cache, and read-only", async () => {
  const res = await worker.fetch(new Request("https://x/api/stats"), ENV, ctx());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "null");

  const post = await worker.fetch(new Request("https://x/api/stats", { method: "POST" }), ENV, ctx());
  assert.equal(post.status, 405);
});

test("a driver's request warms /api/stats with their own token, at most every 15 minutes", async () => {
  const caches = fakeCaches();
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const f = stubFetch((url) => url.endsWith("/rpc/public_stats")
    ? new Response(JSON.stringify(STATS), { status: 200 })
    : new Response("[]", { status: 200 }));
  const statsCalls = () => f.calls.filter((c) => c.url.endsWith("/rpc/public_stats"));
  const read = (auth) => {
    const c = ctx();
    return worker.fetch(new Request("https://x/api/rest/cars?select=id", { headers: auth ? { authorization: auth } : {} }), ENV, c)
      .then(() => Promise.all(c.waits)).then(() => c.waits.length);
  };
  try {
    assert.equal(await read(null), 0, "an anonymous request never schedules a refresh");
    assert.equal(statsCalls().length, 0);

    assert.equal(await read("Bearer driver-1"), 1);
    assert.equal(statsCalls().length, 1);
    assert.equal(statsCalls()[0].init.headers.authorization, "Bearer driver-1");

    const served = await worker.fetch(new Request("https://x/api/stats"), ENV, ctx());
    assert.deepEqual(await served.json(), STATS);

    assert.equal(await read("Bearer driver-2"), 0, "no second lookup within a minute");

    mock.timers.tick(2 * 60 * 1000);
    assert.equal(await read("Bearer driver-2"), 1, "after a minute the cache is checked again");
    assert.equal(statsCalls().length, 1, "but it is fresh, so Neon is not asked");

    mock.timers.tick(16 * 60 * 1000);
    assert.equal(await read("Bearer driver-3"), 1);
    assert.equal(statsCalls().length, 2, "past 15 minutes it is refreshed");
    assert.equal(statsCalls()[1].init.headers.authorization, "Bearer driver-3");
  } finally {
    mock.timers.reset();
    f.restore();
    caches.restore();
  }
});

test("a failed refresh leaves the old stats in place", async () => {
  const caches = fakeCaches();
  mock.timers.enable({ apis: ["Date"], now: 1_900_000_000_000 });
  let fail = false;
  const f = stubFetch((url) => url.endsWith("/rpc/public_stats")
    ? (fail ? new Response("nope", { status: 400 }) : new Response(JSON.stringify(STATS), { status: 200 }))
    : new Response("[]", { status: 200 }));
  const read = async (auth) => {
    const c = ctx();
    await worker.fetch(new Request("https://x/api/rest/cars", { headers: { authorization: auth } }), ENV, c);
    await Promise.all(c.waits);
  };
  const origError = console.error;
  console.error = () => {};
  try {
    await read("Bearer a");
    fail = true;
    mock.timers.tick(20 * 60 * 1000);
    await read("Bearer b");
    const served = await worker.fetch(new Request("https://x/api/stats"), ENV, ctx());
    assert.deepEqual(await served.json(), STATS);
  } finally {
    console.error = origError;
    mock.timers.reset();
    f.restore();
    caches.restore();
  }
});

test("/config.js offers the Google Analytics id only when it is well formed", async () => {
  const cfgOf = async (env) => JSON.parse((await (await worker.fetch(new Request("https://x/config.js"), env, ctx())).text())
    .replace(/^window\.__ENV=/, "").replace(/;$/, ""));
  assert.equal((await cfgOf({ ...ENV })).ga, null);
  assert.equal((await cfgOf({ ...ENV, GA_MEASUREMENT_ID: "" })).ga, null);
  assert.equal((await cfgOf({ ...ENV, GA_MEASUREMENT_ID: "UA-123" })).ga, null);
  assert.equal((await cfgOf({ ...ENV, GA_MEASUREMENT_ID: "G-ABC123XYZ9" })).ga, "G-ABC123XYZ9");
});
