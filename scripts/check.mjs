#!/usr/bin/env node
// Fast checks with no dependencies and no network: `node scripts/check.mjs`.
// CI runs this on every pull request and before every deploy.
//
//   1. Every script parses: src/*.js, public/sw.js, and each page's inline <script>.
//      The app is one HTML file with no build step, so a stray brace ships
//      straight to drivers unless something parses it first.
//   2. Every RPC the pages or the worker call exists in db/schema.sql — and
//      every function the client may call is granted to `authenticated`.
//      A client calling a function the branch lacks fails as PGRST202.
//   3. The two wrangler configs point at different workers, domains and Neon
//      endpoints, so a copy-paste never sends UAT traffic to production.
//   4. Nothing that looks like a secret is committed (the repo is public).

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");
const failures = [];
const fail = (msg) => failures.push(msg);

// ---- 1. syntax -------------------------------------------------------------
// ES modules: node --check on an .mjs copy, since vm only parses scripts.
const tmp = mkdtempSync(join(tmpdir(), "alih-check-"));
for (const f of ["src/worker.js", "src/push.js"]) {
  const copy = join(tmp, f.replace(/\W/g, "_") + ".mjs");
  writeFileSync(copy, read(f));
  const r = spawnSync(process.execPath, ["--check", copy], { encoding: "utf8" });
  if (r.status !== 0) fail(`${f}: ${r.stderr.split("\n").find((l) => /Error/.test(l)) || r.stderr}`);
}
try { new vm.Script(read("public/sw.js"), { filename: "public/sw.js" }); }
catch (e) { fail(`public/sw.js: ${e.message}`); }

const pages = readdirSync(join(root, "public")).filter((f) => f.endsWith(".html"));
const pageSource = {};
for (const page of pages) {
  const html = read(`public/${page}`);
  pageSource[page] = html;
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
  inline.forEach(([, attrs, body], i) => {
    if (/type=["']?(application\/(ld\+)?json|importmap)/.test(attrs)) return;
    try { new vm.Script(body, { filename: `public/${page} <script #${i + 1}>` }); }
    catch (e) { fail(`public/${page} inline script #${i + 1}: ${e.message}`); }
  });
}

// ---- 2. RPCs vs schema -----------------------------------------------------
const schema = read("db/schema.sql");
const defined = new Set([...schema.matchAll(/create or replace function\s+(?:public\.)?([a-z_]+)\s*\(/gi)]
  .map((m) => m[1]));
// Every `grant execute on function ... to <roles incl. authenticated>;` statement.
const granted = new Set();
for (const g of schema.matchAll(/grant execute on function([\s\S]*?)\sto\s+([a-z_,\s]*);/gi)) {
  if (!/\bauthenticated\b/.test(g[2])) continue;
  for (const m of g[1].matchAll(/([a-z_]+)\s*\(/g)) granted.add(m[1]);
}

const called = new Map(); // fn -> where
for (const [page, html] of Object.entries(pageSource)) {
  for (const m of html.matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)) called.set(m[1], `public/${page}`);
}
const worker = read("src/worker.js");
for (const m of worker.matchAll(/rpc\(\s*env\s*,\s*["']([a-z_]+)["']/g)) called.set(m[1], "src/worker.js");
for (const m of worker.matchAll(/new Set\(\[([^\]]*)\]\)/g)) {
  for (const n of m[1].matchAll(/["']([a-z_]+)["']/g)) called.set(n[1], "src/worker.js PUSH_VERBS");
}

for (const [fn, where] of called) {
  if (!defined.has(fn)) fail(`${where} calls rpc "${fn}", which db/schema.sql does not define`);
  else if (where.startsWith("public/") && !granted.has(fn)) {
    fail(`${where} calls rpc "${fn}", but schema.sql does not grant it to authenticated`);
  }
}

// ---- 3. wrangler configs ---------------------------------------------------
const jsonc = (p) => JSON.parse(read(p).replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
let prod, uat;
try { prod = jsonc("wrangler.jsonc"); } catch (e) { fail(`wrangler.jsonc: ${e.message}`); }
try { uat = jsonc("wrangler.uat.jsonc"); } catch (e) { fail(`wrangler.uat.jsonc: ${e.message}`); }
if (prod && uat) {
  const same = (k, get) => { if (get(prod) === get(uat)) fail(`wrangler configs share ${k}: ${get(prod)}`); };
  same("name", (c) => c.name);
  same("route", (c) => c.routes?.[0]?.pattern);
  same("NEON_AUTH_URL", (c) => c.vars?.NEON_AUTH_URL);
  same("NEON_DATA_API_URL", (c) => c.vars?.NEON_DATA_API_URL);
  if (prod.vars?.APP_ENV !== "production") fail(`wrangler.jsonc APP_ENV is ${prod.vars?.APP_ENV}, expected production`);
  if (uat.vars?.APP_ENV !== "uat") fail(`wrangler.uat.jsonc APP_ENV is ${uat.vars?.APP_ENV}, expected uat`);
  for (const [f, c] of [["wrangler.jsonc", prod], ["wrangler.uat.jsonc", uat]]) {
    if (c.vars?.VAPID_PRIVATE_KEY) fail(`${f} carries VAPID_PRIVATE_KEY in vars — it must be a worker secret`);
  }
}

// ---- 4. secrets ------------------------------------------------------------
const tracked = ["src/worker.js", "src/push.js", "public/sw.js", "wrangler.jsonc", "wrangler.uat.jsonc",
  "db/schema.sql", ...pages.map((p) => `public/${p}`)];
const secretish = [
  [/postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i, "a Postgres URL with a password"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
  [/\bnapi_[a-z0-9]{40,}/i, "a Neon API key"],
];
for (const f of tracked) {
  const text = read(f);
  for (const [re, what] of secretish) if (re.test(text)) fail(`${f} contains ${what}`);
}

// ---- 5. the shared frame ---------------------------------------------------
// Every page wears the same sticky header and bottom bar (public/chrome.css), so
// a driver can always get home and always reach the same five places. The bar's
// links and labels must match on every page; only which one is current differs.
const BAR_HREFS = ["/#pD", "/#pS", "/#pG", "/start.html", "/about.html"];
const BAR_LABELS = ["Declare", "Trace", "Garage", "Help", "Contact"];
for (const [page, html] of Object.entries(pageSource)) {
  const where = `public/${page}`;
  if (!/<link[^>]+href="\/chrome\.css"/.test(html)) fail(`${where} does not load /chrome.css`);
  if (!/<header class="appbar">[\s\S]*?<a class="ta" href="\/"[^>]*>TA<\/a>/.test(html)) {
    fail(`${where}: the header must start with <a class="ta" href="/">TA</a> so TA always goes home`);
  }
  const bar = html.match(/<nav class="tabbar"[^>]*>([\s\S]*?)<\/nav>/);
  if (!bar) { fail(`${where} has no bottom bar (<nav class="tabbar">)`); continue; }
  const hrefs = [...bar[1].matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  const labels = [...bar[1].matchAll(/<span class="tx">([^<]+)<\/span>/g)].map((m) => m[1]);
  if (hrefs.join() !== BAR_HREFS.join()) fail(`${where}: bottom bar links are ${hrefs.join(" ")}, expected ${BAR_HREFS.join(" ")}`);
  if (labels.join() !== BAR_LABELS.join()) fail(`${where}: bottom bar labels are ${labels.join(", ")}, expected ${BAR_LABELS.join(", ")}`);
  // The phone number was dropped on purpose (owner decision): no page asks for one.
  if (/type="tel"/.test(html)) fail(`${where} has a phone input; sign-up no longer asks for a phone number`);
}

// ---- report ----------------------------------------------------------------
if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`);
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`✓ ${pages.length} pages, ${called.size} RPCs, 2 wrangler configs — all good.`);
