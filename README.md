# Tolong Alih

Double parking, sorted. The blocker declares the block; the blocked driver is
notified or can trace by plate pair. Neither party ever sees the other's number.

Live: https://alih.nextnovas.com · UAT: https://uat.alih.nextnovas.com

## Layout

```
public/index.html   the whole driver app, single file, no build step
public/admin.html   ads management (to build)
public/_headers     geolocation permission policy
supabase/           migrations, already applied
wrangler.jsonc      production worker
wrangler.uat.jsonc  UAT worker
CLAUDE.md           context for Claude Code — read this first
```

## Workflow

```bash
git checkout develop && git push     # UAT rebuilds
git checkout main && git merge develop && git push   # production rebuilds
```

Run schema changes against `app_alih_prod` before merging to `main`.
