# Schema

Supabase project `llejrncrxjejxvkwqhgj` (Semaian).

- `0001_init.sql` — templated core schema. `{{SCHEMA}}` is replaced with
  `app_alih_uat` or `app_alih_prod` before running.
- `0002_actions.sql` — the four verbs as `security definer` functions, plus
  trace rate limiting. **Applied to `app_alih_uat` only.**
- Applied migrations also include `platform_registry`, `alih_uat_init`,
  `alih_prod_init`, `alih_ads_pricing_and_phone`. Pull the current state with
  `supabase db pull` once the CLI is linked.

## Why the verbs are functions and not table writes

RLS alone cannot express three of the four verbs:

- **flag** — the blocked driver has to reopen someone else's block, but
  `update_blocks` is blocker-only, and has to stay that way.
- **trace** — the whole point is that the blocked driver is *not* registered,
  so `read_blocks` can never match them.
- **declare / clear** — both write messages to the other party. The only policy
  that allowed that was `messages.send_messages`, which was `with check (true)`
  — any signed-in user could forge a message to anyone, from any label.
  `0002` drops it.

So `declare_block`, `clear_block`, `flag_block`, `contact_blocker` and
`trace_block` run as definer, pinned to their schema, and re-check the caller.
Being party to a block means knowing its uuid *and* one of its plates — which is
exactly what trace establishes, so a traced driver can act without registering.

`trace_block` caps a user at 10 traces an hour, recorded in `trace_attempts`.
Without that, trace is plate enumeration with extra steps.

## Applying 0002 to production

Not yet applied. Do this before merging to `main`:

```bash
sed 's/{{SCHEMA}}/app_alih_prod/g' supabase/migrations/0002_actions.sql \
  | psql "$SUPABASE_DB_URL"
```

## Still to do in the dashboard

1. Settings → API → Exposed schemas: add `app_alih_uat` and `app_alih_prod`.
   Until this is done every client call fails, and the app will say
   "Schema app_alih_uat is not exposed in Supabase yet."
2. Authentication → Providers: enable Google, with the client ID and secret from
   the Google Cloud console. The authorised redirect URI to give Google is
   `https://llejrncrxjejxvkwqhgj.supabase.co/auth/v1/callback`.

   The OAuth client lives in GCP project **`cloud-xp`**, under the **Next Novas**
   brand — the umbrella consent screen shared by every Next Novas app. Branding,
   scopes, audience and publishing status are set per *project*, not per client,
   so anything changed there hits the other apps too. Tolong Alih has its own
   client ID under Clients; `nextnovas.com` must stay in Authorized domains.

   Google requires a privacy policy URL on a published External app, and it is
   brand-level. See the PDPA item under "Not yet built" in CLAUDE.md.
3. Authentication → URL Configuration → Redirect URLs: add
   `https://alih.nextnovas.com`, `https://uat.alih.nextnovas.com`, and
   `http://127.0.0.1:8787` for local work.
4. Authentication → Email Templates → Confirm signup: include `{{ .Token }}`.
   The verify gate asks for a six-digit code and the default template only
   carries a link. The link still works — the app picks the session up on
   return — but the code field is dead without this.
5. After your first sign-in, make yourself admin:
   `update app_alih_uat.profiles set is_admin = true where id = '<your-uid>';`
6. Schedule expiry:
   `select cron.schedule('expire_uat','*/10 * * * *',$$select app_alih_uat.expire_blocks()$$);`
