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

- **Frontend**: single static HTML file, no framework, no build step. `public/index.html`.
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

Pushing to the branch deploys it (`.github/workflows/deploy.yml`, needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets).
Manual deploy for UAT: `npx wrangler deploy -c wrangler.uat.jsonc`

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
- Phone number is collected at signup for the fallback call path.

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
