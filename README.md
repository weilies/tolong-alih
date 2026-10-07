# Tolong Alih

Double parking, sorted. The blocker declares the block; the blocked driver is
notified or can trace by plate pair. Neither party ever sees the other's number.

Live: https://alih.nextnovas.com · UAT: https://uat.alih.nextnovas.com

## Layout

```
public/index.html   the whole driver app, single file, no build step
public/admin.html   ads management (to build)
public/_headers     geolocation permission policy, CSP, cache rules
public/vendor/      neon-js, vendored so the app has no runtime CDN
src/worker.js       /config.js from wrangler vars, and same-origin proxies to
                    Neon Auth (/api/auth) and the Data API (/api/rest)
db/                 Neon schema and setup — db/README.md
wrangler.jsonc      production worker
wrangler.uat.jsonc  UAT worker
CLAUDE.md           context for Claude Code — read this first
```

## How the app knows which environment it is in

`public/index.html` is a static file with no build step, so there is nowhere to
bake per-environment values in. `src/worker.js` serves `/config.js` from the
wrangler `vars` of whichever worker is running, and the page reads
`window.__ENV`. It also proxies Neon Auth and the Data API from the app's own
origin, so the session cookie is first-party (see the file header).

Change an environment's Neon endpoints in `wrangler*.jsonc`, nowhere else.

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

Apply `db/schema.sql` to the Neon `main` branch before merging to `main`.

## MCP servers

Neon is a claude.ai connector — it covers the database, branches, Neon Auth
and the Data API. The Neon org is Vercel-managed, so new *projects* are created
from the Vercel dashboard (Storage); everything else works through MCP.
Google Cloud is declared in `.mcp.json` and
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
`db/README.md`.

## Analytics (Google Analytics 4)

One GA4 property per Next Novas app; Tolong Alih's measurement id (`G-…`) goes in
`wrangler.jsonc` as `GA_MEASUREMENT_ID` (empty = off; UAT is always off). Create the
property in the GA console (Admin → Create → Property → Web stream for
`alih.nextnovas.com`), turn Google signals off, set event data retention to 14
months, then paste the id. The `analytics-mcp` server in `.mcp.json`
([googleanalytics/google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp))
reads accounts, properties and reports so Claude can answer campaign questions; it
is read-only and needs `pipx` plus Application Default Credentials with the
`analytics.readonly` scope on your own machine:

```bash
gcloud auth application-default login \
  --scopes https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform
export GOOGLE_PROJECT_ID=<your GCP project id>   # Google Analytics Admin + Data APIs enabled
```

## Running it locally

```bash
npx wrangler dev -c wrangler.uat.jsonc
```

Serves on http://127.0.0.1:8787 against the UAT schema, with `_headers` and
`/config.js` applied. Neon Auth allows localhost origins, so sign-in works
without extra config.
