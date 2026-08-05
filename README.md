# Tolong Alih

Double parking, sorted. The blocker declares the block; the blocked driver is
notified or can trace by plate pair. Neither party ever sees the other's number.

Live: https://alih.nextnovas.com · UAT: https://uat.alih.nextnovas.com

## Layout

```
public/index.html   the whole driver app, single file, no build step
public/admin.html   ads management (to build)
public/_headers     geolocation permission policy, CSP, cache rules
public/vendor/      supabase-js, vendored so the app has no runtime CDN
src/worker.js       serves /config.js from wrangler vars; assets do the rest
supabase/           migrations
wrangler.jsonc      production worker
wrangler.uat.jsonc  UAT worker
CLAUDE.md           context for Claude Code — read this first
```

## How the app knows which environment it is in

`public/index.html` is a static file with no build step, so there is nowhere to
bake `APP_SCHEMA` in. `src/worker.js` serves `/config.js` from the wrangler
`vars` of whichever worker is running, and the page reads `window.__ENV`. That
is the only reason a worker script exists — everything else is static assets.

Change an environment's schema or Supabase project in `wrangler*.jsonc`, nowhere
else.

## Deploying

Pushing deploys, via `.github/workflows/deploy.yml`:

| Branch | Worker | Domain |
|---|---|---|
| `develop` | `tolong-alih-uat` | uat.alih.nextnovas.com |
| `main` | `tolong-alih` | alih.nextnovas.com |

```bash
git checkout develop && git merge <feature> && git push   # UAT rebuilds
git checkout main && git merge develop && git push        # production rebuilds
```

Two repository secrets make that work — Settings → Secrets and variables →
Actions:

- `CLOUDFLARE_API_TOKEN` — My Profile → API Tokens → *Edit Cloudflare Workers*
- `CLOUDFLARE_ACCOUNT_ID` — right-hand sidebar of the Workers dashboard

Manual deploys still work: `npx wrangler deploy -c wrangler.uat.jsonc`.

If you would rather have Cloudflare pull from GitHub directly (Workers → the
worker → Settings → Build), that works too — but delete this workflow if you
switch, so the two do not race each other.

Run the schema migration against `app_alih_prod` before merging to `main`.

## Running it locally

```bash
npx wrangler dev -c wrangler.uat.jsonc
```

Serves on http://127.0.0.1:8787 against the UAT schema, with `_headers` and
`/config.js` applied. Add that origin to Supabase → Authentication → URL
Configuration → Redirect URLs first, or sign-in will bounce.
