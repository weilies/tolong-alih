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

## MCP servers

Supabase is a claude.ai connector, already attached — it covers the database,
migrations, logs and advisors. Google Cloud is declared in `.mcp.json` and
served by [`@google-cloud/gcloud-mcp`](https://github.com/googleapis/gcloud-mcp),
which exposes one tool that runs gcloud commands. Set it up once:

```bash
./scripts/setup-gcloud-mcp.sh    # installs gcloud, signs in, writes the denylist
```

Restart Claude Code afterwards. The script writes a command denylist to
`~/.config/gcloud-mcp/acl.json`; the server runs whatever command it is given,
so that file is the guard rail for irreversible operations.

What it cannot do: create the OAuth client for Sign in with Google. Google has
no API for that at all — clients created through the IAP API are forced
internal-only and locked to IAP, with the redirect URI unmodifiable, and that
API is deprecated. The consent screen and client stay a console job. See
`supabase/README.md`.

## Running it locally

```bash
npx wrangler dev -c wrangler.uat.jsonc
```

Serves on http://127.0.0.1:8787 against the UAT schema, with `_headers` and
`/config.js` applied. Add that origin to Supabase → Authentication → URL
Configuration → Redirect URLs first, or sign-in will bounce.
