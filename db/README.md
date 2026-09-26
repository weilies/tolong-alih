# Database — Neon

Neon project **`tolong-alih`** (`wispy-union-37910963`, aws-ap-southeast-1),
database `neondb`. Created through the Vercel Storage integration — the Neon
org is Vercel-managed, so that is the only way to create a project.

| Neon branch | Branch id | Environment | Worker |
|---|---|---|---|
| `uat` | `br-flat-lake-b33jhfl5` | UAT | `tolong-alih-uat` |
| `main` | `br-snowy-dream-b3myqcc8` | production | `tolong-alih` |

Branches are the environment boundary, so everything lives in `public` — the
`app_alih_<env>` schemas were a Supabase-era workaround for sharing one project
between apps and environments.

Each branch has its own Neon Auth (Better Auth) and its own Data API. Users,
sessions and sign-in config do not cross branches.

## Schema

`schema.sql` is the whole schema, idempotent. Apply it to a branch with the Neon
MCP (`run_sql_transaction`, one statement per item) or psql:

```bash
psql "$NEON_UAT_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
```

Apply to `main` before merging `develop` into `main`, or production ships a
client calling functions that are not there yet.

Design notes live in the file header. The short version:

- The verbs (`declare_block`, `clear_block`, `flag_block`, `contact_blocker`,
  `trace_block`, `say`) are `security definer` RPCs. RLS cannot express flag or
  trace — see `supabase/README.md` for the full reasoning, which still holds.
- Grants are column-scoped: a driver cannot set `profiles.is_admin` or
  `cars.verified`, and has select only on `blocks`, `block_targets`, `messages`.
- `auth.user_id()` (pg_session_jwt) replaces `auth.uid()`. User ids are text.
- No pg_cron on a scale-to-zero compute; `declare_block` and `trace_block`
  expire stale blocks before they read.

## Data API settings (per branch)

- Auth provider: Neon Auth
- Exposed schema: `public`
- Anonymous role: `anonymous` — only `public_stats()` is granted to it, for the
  About page, which calls it with no session.
- Provisioned **without** Neon's default grants (they grant full CRUD on every
  table; `schema.sql` grants per column instead). A side effect: the API roles
  get no USAGE on schema `auth`, which Neon's `cloud_admin` owns and we cannot
  grant. Policies therefore call `public.uid()`, a definer wrapper around
  `auth.user_id()`, never `auth.user_id()` directly.

## Neon Auth settings (per branch)

- Email + password, verify on sign-up with a six-digit **OTP**, verification
  required, auto sign-in after verification. Console-only (Auth → Settings);
  the MCP cannot set it. Until it is on, signup signs straight in — the client
  handles both.
- Google, shared credentials for now. Before production traffic, switch to the
  Tolong Alih OAuth client in GCP project `cloud-xp` (Next Novas brand) and give
  Google the Neon Auth callback URL shown in the Neon console.
- Trusted origins: the environment's domain (`https://uat.alih.nextnovas.com`
  or `https://alih.nextnovas.com`). Localhost is allowed for `wrangler dev`.

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
