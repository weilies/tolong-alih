---
name: ship-uat
description: Deploy Tolong Alih to UAT (uat.alih.nextnovas.com) and prove it works — schema to the Neon uat branch, worker via the Deploy workflow, push keys, smoke checks. Use when asked to ship, deploy, release or "make it live" on UAT, or when a UAT deploy fails.
---

# Ship to UAT

UAT = Neon branch `uat` (`br-flat-lake-b33jhfl5`, project `wispy-union-37910963`)
+ worker `tolong-alih-uat` + `wrangler.uat.jsonc`. Production is the same with
`main`; never touch production unless the user says so in this session.

## 0. Normal path

Open a PR to `develop`; CI must be green; merging deploys UAT, and the Deploy
workflow applies `db/schema.sql` itself when the `uat` environment has
`NEON_DATABASE_URL`. The steps below are for when that path is not available.

## 1. Database first

A client that calls an RPC the branch lacks fails as `PGRST202`. So:

- Diff what the change adds to `db/schema.sql` and apply **only that** to the
  uat branch with Neon MCP `run_sql_transaction`, one statement per item.
- New functions get `EXECUTE` for PUBLIC by default. Re-run the matching
  `revoke`/`grant` lines from the bottom of `schema.sql` for them.
- Verify with a `do $$ … raise exception 'ROLLBACK …' $$` block: exercise the
  function, report results in the exception text, and nothing is committed.

## 2. Worker

Pick whichever works, in this order:

1. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are in the environment →
   `npx --yes wrangler@4 deploy -c wrangler.uat.jsonc`.
2. Otherwise run the **Deploy** workflow with GitHub MCP
   `actions_run_trigger` (`run_workflow`, `deploy.yml`, `ref` = the session
   branch). Any ref other than `main` deploys **UAT**. Read the step logs with
   `get_job_logs`; poll the run with a background
   `until … curl https://api.github.com/repos/weilies/tolong-alih/actions/runs/<id> …` loop
   (the repo is public, so no auth is needed), never with `sleep`.
3. Pushing to `develop` also deploys UAT, but only with the user's go-ahead
   in this session.

`Authentication error [code: 10000]` or `Invalid access token [code: 9109]` on
**every** wrangler call means the `CLOUDFLARE_API_TOKEN` repo secret is dead,
not the code. Only the user can replace it (Cloudflare → My Profile → API
Tokens → "Edit Cloudflare Workers" template → GitHub repo Settings → Secrets →
Actions). Say so once and stop retrying.

## 3. Web Push keys (first deploy of a worker only)

The repo is **public**: never commit a VAPID private key or print it in a log.
The workflow's "VAPID keys (first run only)" step makes the pair as worker
secrets and prints one line, `push_config.key_hash = <hex>`. Put it in the
branch:

```sql
insert into push_config (id, key_hash) values (1, '<hex>')
on conflict (id) do update set key_hash = excluded.key_hash;
```

Without it the test button works but verbs push nothing (`push_drain` refuses
the worker).

## 4. Prove it

- The sandbox usually cannot reach `*.nextnovas.com`; if curl gets `000`, say
  so and do not guess. Read the Cloudflare worker with the Cloudflare MCP if
  connected.
- `/config.js` must carry a non-null `vapidPublicKey` once push is set up.
- Nothing touches a real phone from here. Hand the user the exact taps:
  Android Chrome, open the site (not a link inside another app) → Allow alerts →
  Allow → avatar menu → **Send me a test alert** → lock the phone, ~10 s.
  iPhone: Safari → Share → Add to Home Screen → open from the icon → same.

## 5. Report

What is live, what was verified and how, and what only the user can do next.
