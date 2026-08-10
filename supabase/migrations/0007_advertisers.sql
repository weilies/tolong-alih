-- Tolong Alih — advertiser accounts, and ad counts you can defend.
-- Run once per environment. Replace {{SCHEMA}} with app_alih_uat or app_alih_prod.
--
-- Two problems this fixes.
--
-- One: ads.merchant was free text, so a client running three campaigns could not
-- be grouped, invoiced together, or given a contact record. That breaks the
-- moment there is a second campaign to sell.
--
-- Two, and worse: log_ad_events was `with check (true)`. Any signed-in driver
-- could insert unlimited impressions and clicks against any ad. The numbers an
-- invoice rests on were forgeable by the people being counted, and a rival's
-- daily cap could be drained on purpose. Client inserts are revoked here and
-- replaced by a function that de-duplicates, rate limits, and refuses a click
-- with no matching impression behind it.

-- ---------------- advertisers ----------------

create table if not exists {{SCHEMA}}.advertisers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  contact_name  text,
  contact_phone text,
  contact_email text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create unique index if not exists advertisers_name_uniq
  on {{SCHEMA}}.advertisers (lower(name));

alter table {{SCHEMA}}.advertisers enable row level security;

drop policy if exists admin_advertisers on {{SCHEMA}}.advertisers;
create policy admin_advertisers on {{SCHEMA}}.advertisers for all
  using      (exists (select 1 from {{SCHEMA}}.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from {{SCHEMA}}.profiles p where p.id = auth.uid() and p.is_admin));

grant select, insert, update, delete on {{SCHEMA}}.advertisers to authenticated;

alter table {{SCHEMA}}.ads
  add column if not exists advertiser_id uuid references {{SCHEMA}}.advertisers(id) on delete set null;
create index if not exists ads_advertiser_idx on {{SCHEMA}}.ads (advertiser_id);

-- Existing rows carry the merchant name only. Promote each distinct name to an
-- advertiser so nothing is stranded, then point the ads at them.
insert into {{SCHEMA}}.advertisers (name)
select distinct merchant from {{SCHEMA}}.ads
 where merchant is not null and merchant <> ''
on conflict do nothing;

update {{SCHEMA}}.ads a
   set advertiser_id = v.id
  from {{SCHEMA}}.advertisers v
 where a.advertiser_id is null and lower(a.merchant) = lower(v.name);

-- ---------------- honest event logging ----------------

-- Clients no longer write this table directly.
drop policy if exists log_ad_events on {{SCHEMA}}.ad_events;
revoke insert, update, delete on {{SCHEMA}}.ad_events from authenticated, anon;

create index if not exists ad_events_dedup_idx
  on {{SCHEMA}}.ad_events (ad_id, user_id, slot, event, created_at desc);

create or replace function {{SCHEMA}}.log_ad_event(
  p_ad    uuid,
  p_slot  text,
  p_event text
) returns json
language plpgsql security definer
set search_path = {{SCHEMA}}, public
as $$
declare
  v_uid   uuid := auth.uid();
  v_total int;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'why', 'anonymous');
  end if;

  if p_event not in ('impression','click') then
    raise exception 'Unknown ad event.' using errcode = '22023';
  end if;

  if not exists (select 1 from ads where id = p_ad and active) then
    return json_build_object('ok', false, 'why', 'no such ad');
  end if;

  -- A driver refreshing the alerts tab is not twenty impressions.
  if p_event = 'impression' and exists (
    select 1 from ad_events
     where ad_id = p_ad and user_id = v_uid and slot = p_slot and event = 'impression'
       and created_at > now() - interval '1 hour'
  ) then
    return json_build_object('ok', false, 'why', 'already counted');
  end if;

  -- A click with no impression behind it did not happen.
  if p_event = 'click' and not exists (
    select 1 from ad_events
     where ad_id = p_ad and user_id = v_uid and event = 'impression'
       and created_at > now() - interval '24 hours'
  ) then
    return json_build_object('ok', false, 'why', 'no impression');
  end if;

  if p_event = 'click' and exists (
    select 1 from ad_events
     where ad_id = p_ad and user_id = v_uid and event = 'click'
       and created_at > now() - interval '1 hour'
  ) then
    return json_build_object('ok', false, 'why', 'already counted');
  end if;

  -- Backstop against a scripted client hammering the endpoint.
  select count(*) into v_total from ad_events
   where user_id = v_uid and created_at > now() - interval '1 hour';
  if v_total >= 120 then
    return json_build_object('ok', false, 'why', 'rate limited');
  end if;

  -- Respect the merchant's daily cap rather than overdelivering.
  if p_event = 'impression' and exists (
    select 1 from ads a
     where a.id = p_ad
       and (select count(*) from ad_events e
             where e.ad_id = a.id and e.event = 'impression'
               and e.created_at > date_trunc('day', now())) >= a.daily_cap
  ) then
    return json_build_object('ok', false, 'why', 'daily cap');
  end if;

  insert into ad_events (ad_id, user_id, slot, event) values (p_ad, v_uid, p_slot, p_event);
  return json_build_object('ok', true);
end $$;

revoke execute on function {{SCHEMA}}.log_ad_event(uuid, text, text) from public, anon;
grant execute on function {{SCHEMA}}.log_ad_event(uuid, text, text) to authenticated;
