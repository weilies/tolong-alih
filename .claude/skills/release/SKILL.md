---
name: release
description: Promote what is on UAT (develop) to production (main) for Tolong Alih — release PR, CI, merge, watch the deploy, report the tag. Also the hotfix path and rollback. Use when asked to release, promote, ship to production, cut the weekly/daily release, hotfix or roll back production.
---

# Release to production

Flow: feature branch → PR to `develop` (CI) → merge deploys **UAT** → try it
on uat.alih.nextnovas.com → this skill: PR `develop` → `main` → merge deploys
**production** and tags `release-YYYY.MM.DD-N`.

Merging into `main` is a production deploy. Do it only when the user asked for
a release in this session.

## 1. Is develop releasable?

- `git fetch origin develop main`; `git log --oneline origin/main..origin/develop`.
  Empty → nothing to release; say so and stop.
- The latest **Deploy** run on `develop` (GitHub MCP `actions_list`,
  `list_workflow_runs`, branch `develop`) must be `success` **for the
  `develop` head sha**. A red or missing UAT deploy means it was never on
  UAT — stop and report that.
- `git log origin/develop..origin/main` should be empty apart from earlier
  release merges. A hotfix commit on `main` not yet in `develop` → merge `main`
  into `develop` first (PR to develop) so the release does not drop it.

## 2. Release PR

`create_pull_request` head `develop`, base `main`, title `Release YYYY-MM-DD`.
Body: one line per change from `git log --no-merges --format='- %s' origin/main..origin/develop`,
and any manual step (new worker secret, Neon Auth console setting). CI runs on
the PR (`release-flow`, `checks`, `database`, `smoke`); wait for green via
`pull_request_read` → `get_status`/`get_check_runs`.

## 3. Merge and watch

`merge_pull_request` with `merge_method: merge` (keeps `develop` and `main`
sharing history — never squash a release). Then follow the **Deploy** run on
`main`: CI → schema → worker → Live check → tag. Report the tag, the release
link, and anything the user must try on a phone.

## Hotfix

Branch `hotfix/<what>` from `origin/main`, fix, PR to `main` (CI allows
`hotfix/*`), merge, then PR `main` → `develop` so UAT has it too.

## Rollback

Actions → **Deploy** → Run workflow → branch `main` → action `rollback`
(or `actions_run_trigger` with `inputs: {action: rollback}`, ref `main`).
Only the worker rolls back; schema changes are additive by rule, so the
previous code still runs on the newer schema. Then fix forward with a hotfix.

## Rules that keep rollback safe

- Schema changes are **additive**: add tables, columns, functions. Removing or
  renaming something the live client uses waits until a release where no
  client calls it anymore (expand, release, then contract).
- `db/schema.sql` must stay idempotent — CI applies it twice.
