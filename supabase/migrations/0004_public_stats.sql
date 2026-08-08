-- Tolong Alih — aggregate counters for the public About page.
-- Run once per environment. Replace {{SCHEMA}} with app_alih_uat or app_alih_prod.
--
-- RLS deliberately stops any driver reading another's rows, so a public page
-- cannot count anything by querying tables directly. This returns totals only:
-- no ids, no plates, no timestamps, nothing that identifies a person. Merchants
-- get real reach figures and drivers give up nothing.

create or replace function {{SCHEMA}}.public_stats()
returns json language sql stable security definer
set search_path = {{SCHEMA}}, public
as $$
  select json_build_object(
    'drivers',  (select count(*) from profiles),
    'plates',   (select count(*) from cars),
    'declared', (select count(*) from blocks),
    'resolved', (select count(*) from blocks where status in ('cleared','expired')),
    'mau',      (select count(*) from (
                   select blocker_id as who from blocks
                    where declared_at > now() - interval '30 days'
                   union
                   select to_user as who from messages
                    where created_at > now() - interval '30 days' and to_user is not null
                 ) active)
  )
$$;

grant execute on function {{SCHEMA}}.public_stats() to anon, authenticated;
