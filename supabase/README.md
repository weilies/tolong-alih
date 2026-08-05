# Schema

Already applied to Supabase project `llejrncrxjejxvkwqhgj` (Semaian).

- `0001_init.sql` — templated core schema. `{{SCHEMA}}` is replaced with
  `app_alih_uat` or `app_alih_prod` before running.
- Applied migrations also include `platform_registry`, `alih_uat_init`,
  `alih_prod_init`, `alih_ads_pricing_and_phone`. Pull the current state with
  `supabase db pull` once the CLI is linked.

## Still to do in the dashboard

1. Settings -> API -> Exposed schemas: add `app_alih_uat` and `app_alih_prod`
2. Auth -> Providers: enable Google
3. After your first sign-in, make yourself admin:
   `update app_alih_uat.profiles set is_admin = true where id = '<your-uid>';`
4. Schedule expiry:
   `select cron.schedule('expire_uat','*/10 * * * *',$$select app_alih_uat.expire_blocks()$$);`
