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

Deploy command for UAT: `npx wrangler deploy -c wrangler.uat.jsonc`

## Database

One Supabase project hosts several small apps. `platform` schema is the control plane:
`platform.apps`, `platform.app_envs`, `platform.provision_env(slug, env)`,
`platform.inventory`. Every app+env gets schema `app_<slug>_<env>`.
`auth.users` is shared across apps; isolation is schema + RLS.

Tables per env: `profiles`, `cars`, `blocks`, `block_targets`, `messages`,
`push_subs`, `ads`, `ad_events`. View: `ad_performance`.
All have RLS enabled. Migrations in `supabase/migrations/` are already applied.

**Client must set the schema**, e.g.
`createClient(url, anonKey, { db: { schema: import.meta.env.APP_SCHEMA } })`

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

1. **Wire Supabase auth** — Google OAuth + email/password with verification.
   Capture phone at signup into `profiles.phone`.
2. **Replace the in-memory `DB` object** in `public/index.html` with real queries.
   The UI is done; only the data layer is fake.
3. **Web Push** — service worker, VAPID keys, Supabase Edge Function that fires
   on block declare. This is what makes the product work. iOS Safari needs the
   site added to home screen first.
4. **`public/admin.html`** — ads CRUD, gated on `profiles.is_admin`.
   Read `ad_performance` for the monthly invoice numbers.
5. **pg_cron** to run `expire_blocks()` every 10 minutes per schema.

## Not yet built

- Rate limiting on `trace` (cap attempts/user/hour or it becomes plate enumeration)
- PDPA: privacy notice, consent log, data export, account deletion
- Abuse: block/report, rule for repeat `flag` against one driver
- IP-country fallback when GPS fails
