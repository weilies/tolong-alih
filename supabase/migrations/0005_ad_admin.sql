-- Tolong Alih — lock the ad performance report to admins.
-- Run once per environment. Replace {{SCHEMA}} with app_alih_uat or app_alih_prod.
--
-- ad_events carries an insert policy and no select policy, because drivers log
-- impressions and must never read them back. ad_performance reads ad_events,
-- and a plain view runs as its owner rather than the caller, so granting it to
-- authenticated would hand every signed-in driver the merchant list, their
-- impression counts and their spend. Revoke the view and serve the report from
-- a function that checks is_admin instead.

revoke all on {{SCHEMA}}.ad_performance from anon, authenticated;

create or replace function {{SCHEMA}}.ad_report()
returns setof {{SCHEMA}}.ad_performance
language plpgsql stable security definer
set search_path = {{SCHEMA}}, public
as $$
begin
  if not exists (
    select 1 from profiles where id = auth.uid() and is_admin
  ) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;

  return query select * from {{SCHEMA}}.ad_performance;
end $$;

revoke execute on function {{SCHEMA}}.ad_report() from public, anon;
grant execute on function {{SCHEMA}}.ad_report() to authenticated;

-- The shipped admin_ads policy is `for all using (...)` with no with-check, so
-- inserts fall back to the using expression. State it explicitly so a future
-- edit cannot quietly open writes to everyone.
drop policy if exists admin_ads on {{SCHEMA}}.ads;
create policy admin_ads on {{SCHEMA}}.ads for all
  using      (exists (select 1 from {{SCHEMA}}.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from {{SCHEMA}}.profiles p where p.id = auth.uid() and p.is_admin));
