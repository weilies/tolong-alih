# Tolong Alih — context for Claude Code

Malaysian double-parking resolution app. A driver who double-parks **declares** the
block; the driver they've boxed in is notified instantly, or can **trace** the pair of
plates if they aren't registered. Blocker **clears** the block when they move; the
blocked driver can **flag** it if the blocker cleared early and is still there.

Solo project. Prefer boring, cheap, few dependencies. TypeScript/JavaScript.

## Verb lexicon — keep these exact words in UI, code, and DB

| Verb | Actor | Meaning |
|---|---|---|
| declare | blocker | opens a block |
| clear | blocker | closes it, no confirmation needed |
| flag | blocked driver | reopens a block that was cleared too early |
| trace | blocked driver | find blocker by entering both plates |

## Stack

- **Frontend**: static HTML, no framework, no build step. `public/index.html` is
  the app; `public/start.html` explains it and walks through setup (install,
  sign up, add a plate) — a browser that has never opened the app and has no
  session is sent there first (`localStorage["alih.seen"]`, set once the
  welcome page is shown). **Every page wears the same frame** (`public/chrome.css`,
  enforced by `scripts/check.mjs`): a sticky header — `TA` at left is always the
  way home, BM/EN toggle at right, and in the app a bell (red dot while a live
  block has an urgent message for you; this replaced the Alerts tab) and the
  avatar — and a sticky bottom bar: Declare, Trace, Garage, Help (`start.html`),
  Contact (`about.html`). Those links are plain `/#pD /#pS /#pG` anchors the app
  turns into panel switches. `terms.html` is the plain-words terms of use,
  linked from the footer and sign-up. The ads console link and `admin.html` are
  for `weilies.chok@gmail.com` only (a hidden link; `profiles.is_admin` in the
  database is the real lock). Never promise in it anything the app does not do — it says
  we never sell data or phone numbers, and that location goes to OpenStreetMap
  for the place name. Every page links back to the app. Its screenshots in
  `public/guide/` are the real app with Neon faked: `npx playwright test -c
  test/guide` regenerates them after a UI change.
- **Copy**: plain words a first-time driver understands. Keep the four verbs as
  names (Declare, Clear, Flag, Trace), but explain them in everyday language
  next to them. Every English string the page shows has a BM entry in `MS`.
- **Host**: Cloudflare Workers static assets. Two workers, one repo.
- **Backend**: Neon — Postgres, Neon Auth (managed Better Auth) and the Data API
  (PostgREST). Project `tolong-alih`, aws-ap-southeast-1. See `db/README.md`.
  Moved off Supabase in September 2026; nothing in this repo talks to it any
  more. The old migrations are in git history before that move.
- **Platform map**: every Next Novas app, env, host, DB and auth lives in
  `nextnovas/docs/architecture.md`. Change the stack here → update it there in
  the same piece of work.

## Environments

| | UAT | Production |
|---|---|---|
| Neon branch | `uat` | `main` |
| Worker | `tolong-alih-uat` | `tolong-alih` |
| Domain | uat.alih.nextnovas.com | alih.nextnovas.com |
| Branch | `develop` | `main` |
| Config | `wrangler.uat.jsonc` | `wrangler.jsonc` |

### Release flow

feature branch → PR to `develop` → merge deploys **UAT** → try it there →
PR `develop` → `main` → merge deploys **production**, tagged
`release-YYYY.MM.DD-N`. PRs into `main` come only from `develop` or
`hotfix/*` (CI enforces it). Runbooks: `ship-uat` and `release` skills in
`.claude/skills/`.

- **CI** (`.github/workflows/ci.yml`) runs on every PR and before every
  deploy. Run the same locally before pushing:
  `npm run check && npm test` (no install needed), `npm ci && npm run smoke`
  (Playwright: real pages, real worker, Neon faked in the browser). The
  `database` job applies `db/schema.sql` twice to a stock Postgres
  (`test/db/stub.sql` stands in for Neon) and runs `test/db/verbs.sql`.
- **Deploy** (`.github/workflows/deploy.yml`): CI → `schema.sql` to the Neon
  branch (needs the `NEON_DATABASE_URL` environment secret, else skipped with a
  warning) → worker → live check of `/config.js` → release tag (main only).
  Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (repo).
- **Rollback**: Actions → Deploy → Run workflow → `main` → `rollback`. Worker
  only; that is safe because schema changes are additive by rule — never drop
  or rename what the live client still calls.
- New behaviour gets a smoke test in `test/smoke/app.spec.mjs`; a new or
  changed verb gets a case in `test/db/verbs.sql`.
- **Release names**: every deploy stamps `RELEASE` and `COMMIT` on the worker
  (`wrangler deploy --var`). Production is `release-YYYY.MM.DD-N` — the same
  name as its GitHub release tag; UAT is `uat-YYYY.MM.DD-N`; local is `dev`.
  N is the Deploy run number. `/config.js` serves both and every page footer
  shows them, linked to the tag or commit.
- **Wrangler** is pinned once, `env.WRANGLER` in `deploy.yml`. Bump it there.
- Manual UAT deploy of any branch: `workflow_dispatch` on Deploy (only `main`
  picks the production config), or `npx wrangler deploy -c wrangler.uat.jsonc`.

### SQL runs without a prompt

`.claude/settings.json` lets Claude run Neon SQL (`run_sql`,
`run_sql_transaction`) and schema reads without asking; deleting or resetting
a branch or project still asks. The prompt is gone, the judgement is not:
on the `main` branch (production), Claude states the SQL and gets a yes in
the session before any `delete`, `update` without a narrow `where`, `drop`,
`truncate` or `revoke`. Additive schema from `db/schema.sql` and reads need
no yes. On `uat`, go ahead.

**Production users are never deleted** (owner rule, October 2026, the app is
launching): no deleting auth users, profiles, cars or blocks on `main`, and no
cleanup scripts that do — not even test accounts, not even when asked in passing.
Only the owner removes a production user, by hand. Test-account cleanup is for
`uat` only.

### Lessons that cost a session

- **The repo is public.** No keys in `wrangler*.jsonc`, commits or CI logs.
  Secrets are made inside CI or set as worker secrets; logs may print hashes only.
- **Every wrangler call failing with `Authentication error` / `Invalid access
  token` = the `CLOUDFLARE_API_TOKEN` secret is dead.** Only the user can
  replace it. Report it once; do not retry.
- **Nothing here reaches a real phone**, and the sandbox usually cannot open
  the live sites. Say what was verified (simulation, headless Chromium,
  Neon rollback test) and hand the user the exact taps for the rest.
- **Web Push on iPhone needs Add to Home Screen; on Android it needs Chrome
  itself** — browsers inside other apps (WebView) have no push. Android in
  desktop mode reports a Mac user agent; detect Android first.
- **The user is usually alone, with a phone and a laptop.** Tests they run
  should need no second person: one account signed in on each device. The old
  "Send me a test alert" button was removed on purpose; do not bring it back.

`src/worker.js` serves `/config.js` from its wrangler `vars` (the page reads
`window.__ENV`), and proxies Neon Auth at `/api/auth/*` and the Data API at
`/api/rest/*`. The auth proxy is load-bearing: Neon Auth's session is a cookie,
and set by `*.neon.tech` it is third-party, which iOS Safari drops. Per-env
config belongs in `wrangler*.jsonc` and nowhere else.

## Database

A dedicated Neon project; each Neon branch is one environment, all in `public`.
`db/schema.sql` is the whole schema, idempotent — apply it per branch.

Tables: `profiles`, `cars`, `blocks`, `block_targets`, `messages`,
`advertisers`, `ads`, `ad_events`, `trace_attempts`, `push_subscriptions`,
`push_config`. View: `ad_performance`.
All have RLS enabled; grants are column-scoped (a driver cannot set
`profiles.is_admin` or `cars.verified`). User ids are text from
`auth.user_id()`.

Client: `window.neon.createClient({ auth:{ url, adapter: SupabaseAuthAdapter() },
dataApi:{ url } })` — the adapter keeps `sb.auth.*` Supabase-shaped.

**The four verbs are RPCs, not table writes** — `declare_block`, `clear_block`,
`flag_block`, `contact_blocker`, `trace_block`, all `security definer`
(`db/schema.sql`). RLS cannot express flag (victim updates the blocker's row)
or trace (victim is unregistered by definition), and letting the client write
`messages` directly meant anyone could forge one. Add new cross-party actions as
RPCs too; do not loosen a policy to make a write work.


## Decisions already made — do not relitigate

- **No QR stickers.** Everything is online.
- **No document/ID verification.** Users self-declare plates. Conversations are
  segregated by authenticated profile, so a wrong plate can't read someone else's thread.
- **Blocker clears without confirmation** — the blocked driver may be streets away.
  The blocked driver can `flag` if the blocker bluffed.
- **Location is mandatory** to use the service (visiting the page is fine).
  Gate on country, not precision — fall back to IP-country if GPS fails indoors.
- **Ads are direct-sold to local merchants**, self-hosted, first-party.
  Never a third-party ad network SDK.
- **No phone number.** Sign-up is email or Google only; asking for a phone was
  friction (owner decision, October 2026). `profiles.phone` stays as an unused
  column for accounts made before that; nothing reads or writes it, the check
  script fails any `type="tel"` input, and the terms say we don't ask for one.
  Without it there is no out-of-band way to reach a driver whose push is off, so
  alerts rely on Web Push and the in-app list.

## Build order (highest value first)

1. ~~**Wire auth**~~ — done (now Neon Auth). Google OAuth + email/password with
   six-digit verification; phone captured at signup into `profiles.phone`.
2. ~~**Replace the in-memory `DB` object**~~ — done. All four verbs, garage,
   inbox and ads read from Postgres. Alerts refresh on a 45s poll and on tab
   focus; Web Push replaces that.
3. ~~**Web Push**~~ — built. `public/sw.js` + `manifest.webmanifest`; the worker
   sends after every verb that writes a message (`src/push.js`, RFC 8291/8292
   on WebCrypto, no deps). `messages.pushed_at` is the outbox, `push_drain`
   claims it behind a key only the worker holds. iOS needs Add to Home Screen
   first; the app says so. VAPID keys are worker secrets the deploy workflow makes
   once per env — see `db/README.md`. The 45s poll stays as the fallback.
4. **`public/admin.html`** — ads CRUD, gated on `profiles.is_admin`.
   Read `ad_performance` for the monthly invoice numbers.
5. ~~**pg_cron** for `expire_blocks()`~~ — replaced by lazy expiry inside
   `declare_block` and `trace_block` (no cron on a scale-to-zero compute).

## Not yet built

- ~~Rate limiting on `trace`~~ — done, 10/user/hour in `trace_block`.
- "Is this your car?" confirmation on the first block received. `cars.plate_norm`
  is uniquely indexed, so a squatter can claim a plate and take its alerts. This
  is the agreed mitigation — not document checks.
- PDPA: privacy notice, consent log, data export, account deletion
- Abuse: block/report, rule for repeat `flag` against one driver
- IP-country fallback when GPS fails
- The CSP in `public/_headers` needs `script-src 'unsafe-inline'` because the app
  is one file with an inline script. Moving the script out would let it tighten.
