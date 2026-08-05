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
- **Backend**: Supabase (Postgres + Auth). Project `Semaian`, ref `llejrncrxjejxvkwqhgj`, ap-southeast-1.

## Environments

| | UAT | Production |
|---|---|---|
| Schema | `app_alih_uat` | `app_alih_prod` |
| Worker | `tolong-alih-uat` | `tolong-alih` |
| Domain | uat.alih.nextnovas.com | alih.nextnovas.com |
| Branch | `develop` | `main` |
| Config | `wrangler.uat.jsonc` | `wrangler.jsonc` |

Pushing to the branch deploys it (`.github/workflows/deploy.yml`, needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets).
Manual deploy for UAT: `npx wrangler deploy -c wrangler.uat.jsonc`

`src/worker.js` exists for one reason: a static file has nowhere to bake
`APP_SCHEMA` in, so the worker serves `/config.js` from its wrangler `vars` and
the page reads `window.__ENV`. Per-env config belongs in `wrangler*.jsonc` and
nowhere else.

## Database

One Supabase project hosts several small apps. `platform` schema is the control plane:
`platform.apps`, `platform.app_envs`, `platform.provision_env(slug, env)`,
`platform.inventory`. Every app+env gets schema `app_<slug>_<env>`.
`auth.users` is shared across apps; isolation is schema + RLS.

Tables per env: `profiles`, `cars`, `blocks`, `block_targets`, `messages`,
`push_subs`, `ads`, `ad_events`, `trace_attempts`. View: `ad_performance`.
All have RLS enabled.

**Client must set the schema**:
`createClient(url, anonKey, { db: { schema: window.__ENV.schema } })`

**The four verbs are RPCs, not table writes** — `declare_block`, `clear_block`,
`flag_block`, `contact_blocker`, `trace_block`, all `security definer`
(`0002_actions.sql`). RLS cannot express flag (victim updates the blocker's row)
or trace (victim is unregistered by definition), and letting the client write
`messages` directly meant anyone could forge one. Add new cross-party actions as
RPCs too; do not loosen a policy to make a write work.

`0002_actions.sql` is applied to `app_alih_uat` only — run it against
`app_alih_prod` before merging to `main`.

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

1. ~~**Wire Supabase auth**~~ — done. Google OAuth + email/password with
   six-digit verification; phone captured at signup into `profiles.phone`.
2. ~~**Replace the in-memory `DB` object**~~ — done. All four verbs, garage,
   inbox and ads read from Postgres. Alerts refresh on a 45s poll and on tab
   focus; Web Push replaces that.
3. **Web Push** — service worker, VAPID keys, Supabase Edge Function that fires
   on block declare. This is what makes the product work. iOS Safari needs the
   site added to home screen first.
4. **`public/admin.html`** — ads CRUD, gated on `profiles.is_admin`.
   Read `ad_performance` for the monthly invoice numbers.
5. **pg_cron** to run `expire_blocks()` every 10 minutes per schema.

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
