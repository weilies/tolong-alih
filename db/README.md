# Database — Neon

Neon project **`tolong-alih`** (`wispy-union-37910963`, aws-ap-southeast-1),
database `neondb`. Created through the Vercel Storage integration — the Neon
org is Vercel-managed, so that is the only way to create a project.

| Neon branch | Branch id | Environment | Worker |
|---|---|---|---|
| `uat` | `br-flat-lake-b33jhfl5` | UAT | `tolong-alih-uat` |
| `main` | `br-snowy-dream-b3myqcc8` | production | `tolong-alih` |

Branches are the environment boundary, so everything lives in `public`. (On
Supabase, one shared project hosted both environments as `app_alih_uat` /
`app_alih_prod` schemas; that ended with the move to Neon.)

Each branch has its own Neon Auth (Better Auth) and its own Data API. Users,
sessions and sign-in config do not cross branches.

## Schema

`schema.sql` is the whole schema, idempotent. Apply it to a branch with the Neon
MCP (`run_sql_transaction`, one statement per item) or psql:

```bash
psql "$NEON_UAT_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
```

The Deploy workflow applies it before the worker on every deploy when the
environment has `NEON_DATABASE_URL` (see CLAUDE.md, Release flow). Without that
secret, apply it to `main` by hand before merging `develop` into `main`, or
production ships a client calling functions that are not there yet. CI applies
it twice to a stock Postgres on every PR, so it must stay idempotent.

Design notes live in the file header. The short version:

- The verbs (`declare_block`, `clear_block`, `flag_block`, `contact_blocker`,
  `trace_block`, `say`) are `security definer` RPCs — see below.
- Grants are column-scoped: a driver cannot set `profiles.is_admin` or
  `cars.verified`, and has select only on `blocks`, `block_targets`, `messages`.
- `auth.user_id()` (pg_session_jwt) replaces `auth.uid()`. User ids are text.
- No pg_cron on a scale-to-zero compute; `declare_block` and `trace_block`
  expire stale blocks before they read.

## Why the verbs are functions and not table writes

RLS alone cannot express three of the four verbs:

- **flag** — the blocked driver has to reopen someone else's block, but only
  the blocker may update a block, and that has to stay so.
- **trace** — the whole point is that the blocked driver is *not* registered
  against the block, so no read policy can ever match them.
- **declare / clear** — both write messages to the other party. Allowing that
  from the client means a `messages` insert policy of `with check (true)`, and
  then any signed-in user can forge a message to anyone, from any label.

So the verbs run as definer, pinned to `public`, and re-check the caller. Being
party to a block means knowing its uuid *and* one of its plates — exactly what
trace establishes, so a traced driver can act without registering.

`trace_block` caps a user at 10 traces an hour (`trace_attempts`). Without that,
trace is plate enumeration with extra steps. Add new cross-party actions as
RPCs too; do not loosen a policy to make a write work.

## Data API settings (per branch)

- Auth provider: Neon Auth
- Exposed schema: `public`
- Anonymous role: `anonymous`, with only `public_stats()` and the push functions
  granted to it. **It does not help:** since the end of September the Data API
  answers any request without a bearer JWT with `400 missing authentication
  credentials`, whatever the anonymous role may call. So nothing calls Neon
  without a token. The worker borrows the signed-in driver's own: `push_drain`
  after each verb, and `public_stats` for the Help page, which reads the worker's
  cached `/api/stats` (see `src/worker.js`).
- Provisioned **without** Neon's default grants (they grant full CRUD on every
  table; `schema.sql` grants per column instead). A side effect: the API roles
  get no USAGE on schema `auth`, which Neon's `cloud_admin` owns and we cannot
  grant. Policies therefore call `public.uid()`, a definer wrapper around
  `auth.user_id()`, never `auth.user_id()` directly.

## Neon Auth settings (per branch)

- Email + password, verify on sign-up with a six-digit **OTP**, verification
  required, auto sign-in after verification. **On for both `uat` and `main`.**
  Console-only (Auth → Settings); the MCP cannot set it, and it is per branch,
  so check both after any new branch. With it off, signup signs straight in.
  Neon answers an unverified sign-in with 403 `EMAIL_NOT_VERIFIED`; the client
  sends that user to the code screen.
- Google: the Tolong Alih OAuth clients ("Tolong Alih UAT" and "Tolong Alih
  Production") in the GCP project **Next Novas**, which holds the single consent
  screen for every Next Novas app (name and logo "Next Novas", privacy and terms
  on www.nextnovas.com, authorized domain `nextnovas.com`). Each client's
  redirect URI is the callback Neon shows for that branch. A new app adds its own
  client to the same project. Email accounts that are never verified cannot be
  linked by a later Google sign-in; verifying first makes it one account.
- Trusted origins: the environment's domain (`https://uat.alih.nextnovas.com`
  or `https://alih.nextnovas.com`). Localhost is allowed for `wrangler dev`.

## Web Push (per environment)

The worker sends pushes itself (`src/push.js`) with a VAPID key pair held as
two worker secrets, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. The deploy
workflow makes them on a worker's first deploy and prints one line:

    push_config.key_hash = <64 hex>

Put that in the branch so `push_drain` recognises the worker:

```sql
insert into push_config (id, key_hash) values (1, '<64 hex>')
on conflict (id) do update set key_hash = excluded.key_hash;
```

Until the secrets exist `/config.js` sends `vapidPublicKey: null` and the app
shows no push prompt; until the hash is in, verbs send nothing (the test button
still works). To rotate, delete both secrets and redeploy — every driver
re-subscribes on their next visit.

## Making yourself admin

After your first sign-in on the branch:

```sql
update profiles set is_admin = true
 where id = (select id::text from neon_auth."user" where email = 'you@example.com');
```

## The vendored client

`public/vendor/neon-js-0.7.0-beta.js` is `@neondatabase/neon-js` bundled as an
IIFE exposing `window.neon = { createClient, SupabaseAuthAdapter }`. The adapter
keeps `sb.auth.*` Supabase-shaped, so the app code barely changed. Rebuild:

```bash
mkdir /tmp/nb && cd /tmp/nb && npm init -y && npm i @neondatabase/neon-js@<ver> esbuild
printf 'import { createClient, SupabaseAuthAdapter } from "@neondatabase/neon-js";\nwindow.neon = { createClient, SupabaseAuthAdapter };\n' > entry.js
npx esbuild entry.js --bundle --minify --format=iife --platform=browser \
  --target=es2019 --legal-comments=none --outfile=neon-js.js
```

It needs a secure context (`crypto.randomUUID`) — https or localhost.
