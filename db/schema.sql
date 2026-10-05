-- Tolong Alih — full schema for Neon.
--
-- One file, idempotent, applied per Neon branch: `uat` for UAT, `main` for
-- production. Branches are the environment boundary now, so everything lives in
-- `public` — no more app_alih_<env> schemas.
--
-- Ported from the Supabase migrations 0001–0008 (deleted with the move; see git
-- history before September 2026). What changed in the port:
--
--   * auth.uid() -> auth.user_id(). Neon Auth ids arrive as text in the JWT, so
--     every user column is text and there is no FK to a users table.
--   * Supabase roles anon/authenticated -> Neon Data API roles
--     anonymous/authenticated.
--   * Grants are explicit and column-scoped. Supabase handed `authenticated`
--     full table privileges by default and left RLS to do the work, which meant
--     a driver could `update profiles set is_admin = true` on their own row, or
--     mark their own car verified. Neither is possible here.
--   * Clients get select only on blocks, block_targets and messages. The verbs
--     were already RPC-only in practice; now nothing else is even granted.
--   * No pg_cron on a scale-to-zero compute, so declare_block and trace_block
--     expire stale blocks lazily before they read.
--   * ad_performance and the ads.rate_sen / ads.contact_phone columns were only
--     ever created in the Supabase dashboard; they are reconstructed here from
--     what admin.html reads and writes.

-- ================= tables =================

create table if not exists profiles (
  id           text primary key,
  display_name text,
  phone        text,
  is_admin     boolean not null default false,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create table if not exists cars (
  id         uuid primary key default gen_random_uuid(),
  owner_id   text not null,
  plate      text not null,
  plate_norm text generated always as (upper(regexp_replace(plate,'[^A-Za-z0-9]','','g'))) stored,
  nickname   text,
  verified   boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists cars_plate_norm_uniq on cars (plate_norm);
create index if not exists cars_owner_idx on cars (owner_id);

create table if not exists blocks (
  id                 uuid primary key default gen_random_uuid(),
  blocker_id         text not null,
  blocker_plate_norm text not null,
  eta_minutes        int not null default 15,
  lat                double precision,
  lng                double precision,
  accuracy_m         int,
  status             text not null default 'open'
                     check (status in ('open','cleared','disputed','expired')),
  declared_at        timestamptz not null default now(),
  cleared_at         timestamptz,
  expires_at         timestamptz not null default (now() + interval '2 hours')
);
create index if not exists blocks_status_idx  on blocks (status, declared_at desc);
create index if not exists blocks_blocker_idx on blocks (blocker_id);

create table if not exists block_targets (
  id                uuid primary key default gen_random_uuid(),
  block_id          uuid not null references blocks(id) on delete cascade,
  victim_plate_norm text not null,
  victim_id         text,
  notified          boolean not null default false
);
create unique index if not exists block_targets_uniq on block_targets (block_id, victim_plate_norm);
create index if not exists block_targets_plate_idx on block_targets (victim_plate_norm);

create table if not exists messages (
  id         uuid primary key default gen_random_uuid(),
  block_id   uuid not null references blocks(id) on delete cascade,
  to_user    text,
  from_user  text,
  from_label text not null,
  kind       text not null default 'info' check (kind in ('hot','info','cool')),
  body       text not null,
  is_typed   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_to_idx    on messages (to_user, created_at desc);
create index if not exists messages_block_idx on messages (block_id, created_at);

create table if not exists advertisers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  contact_name  text,
  contact_phone text,
  contact_email text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create unique index if not exists advertisers_name_uniq on advertisers (lower(name));

create table if not exists ads (
  id            uuid primary key default gen_random_uuid(),
  advertiser_id uuid references advertisers(id) on delete set null,
  merchant      text not null,
  mark          text not null default 'AD',
  headline      text not null,
  body          text not null,
  cta_url       text,
  lat           double precision,
  lng           double precision,
  radius_m      int not null default 3000,
  slots         text[] not null default array['interstitial','alert','trace'],
  daily_cap     int not null default 1000,
  rate_sen      int not null default 0,     -- monthly fee, in sen
  contact_phone text,
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz not null default (now() + interval '90 days'),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists ads_active_idx     on ads (active, starts_at, ends_at);
create index if not exists ads_advertiser_idx on ads (advertiser_id);

create table if not exists ad_events (
  id         bigserial primary key,
  ad_id      uuid not null references ads(id) on delete cascade,
  user_id    text,
  slot       text not null,
  event      text not null check (event in ('impression','click')),
  created_at timestamptz not null default now()
);
create index if not exists ad_events_ad_idx    on ad_events (ad_id, created_at desc);
create index if not exists ad_events_dedup_idx on ad_events (ad_id, user_id, slot, event, created_at desc);

-- Without a cap, trace degrades into plate enumeration.
create table if not exists trace_attempts (
  id         bigserial primary key,
  user_id    text not null,
  created_at timestamptz not null default now()
);
create index if not exists trace_attempts_user_idx on trace_attempts (user_id, created_at desc);

-- Web Push. One row per browser that said yes; a phone can outlive an account,
-- so the endpoint is the key and a new sign-in on the same phone takes it over.
create table if not exists push_subscriptions (
  endpoint   text primary key,
  user_id    text not null,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

-- messages doubles as the push outbox: the worker claims unsent rows after
-- every verb. See push_drain().
alter table messages add column if not exists pushed_at timestamptz;
create index if not exists messages_unpushed_idx on messages (created_at) where pushed_at is null;

-- sha256 of the worker's push key, set per branch (db/README.md). Single row.
create table if not exists push_config (
  id       int primary key default 1 check (id = 1),
  key_hash text not null
);

-- One row per ad per month: what the invoice is built from.
create or replace view ad_performance as
select a.id                                   as ad_id,
       a.advertiser_id,
       a.merchant,
       date_trunc('month', e.created_at)      as period,
       count(*) filter (where e.event = 'impression') as impressions,
       count(*) filter (where e.event = 'click')      as clicks,
       round(100.0 * count(*) filter (where e.event = 'click')
             / nullif(count(*) filter (where e.event = 'impression'), 0), 2) as ctr_pct,
       a.rate_sen
  from ads a
  join ad_events e on e.ad_id = a.id
 group by a.id, a.advertiser_id, a.merchant, date_trunc('month', e.created_at), a.rate_sen;

-- ================= helpers =================

create or replace function plate_norm(p text)
returns text language sql immutable
set search_path = ''
as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

create or replace function is_block_target(p_block uuid, p_plate text)
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from block_targets t
     where t.block_id = p_block and t.victim_plate_norm = public.plate_norm(p_plate)
  )
$$;

-- The caller's user id, for policies. Policies run as the calling role, and on
-- a branch whose Data API was provisioned without Neon's default grants,
-- anonymous/authenticated have no USAGE on schema auth (owned by Neon's
-- cloud_admin, so we cannot grant it). As definer this runs as the owner, who
-- can; the JWT claims it reads are per-session, so the answer is the same.
create or replace function uid()
returns text language sql stable security definer
set search_path = ''
as $$ select auth.user_id() $$;

-- Policy helpers run as owner so blocks <-> block_targets policies do not
-- recurse into each other (42P17 infinite recursion).
create or replace function i_declared(p_block uuid)
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from blocks where id = p_block and blocker_id = auth.user_id())
$$;

create or replace function i_am_blocked(p_block uuid)
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from block_targets t
      join cars c on c.plate_norm = t.victim_plate_norm
     where t.block_id = p_block and c.owner_id = auth.user_id()
  )
$$;

create or replace function is_admin()
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.user_id() and is_admin)
$$;

create or replace function expire_blocks() returns void
language sql security definer
set search_path = public
as $$
  -- A block ends when its time is up, and never later than 24 hours after it
  -- was declared. Disputed (flagged) blocks used to be skipped here, so a flag
  -- could leave a block open forever; the 24 hour cap also covers a driver who
  -- moved and never opened the app again.
  update blocks set status = 'expired'
   where status in ('open', 'disputed')
     and (expires_at < now() or declared_at < now() - interval '24 hours');
$$;

-- ================= RLS =================

alter table profiles       enable row level security;
alter table cars           enable row level security;
alter table blocks         enable row level security;
alter table block_targets  enable row level security;
alter table messages       enable row level security;
alter table advertisers    enable row level security;
alter table ads            enable row level security;
alter table ad_events      enable row level security;   -- no policies: function-only
alter table trace_attempts enable row level security;   -- no policies: function-only
alter table push_subscriptions enable row level security; -- no policies: function-only
alter table push_config    enable row level security;   -- no policies: function-only

drop policy if exists own_profile on profiles;
create policy own_profile on profiles for all
  using (id = (select uid())) with check (id = (select uid()));

drop policy if exists own_cars on cars;
create policy own_cars on cars for all
  using (owner_id = (select uid())) with check (owner_id = (select uid()));

drop policy if exists read_blocks on blocks;
create policy read_blocks on blocks for select
  using (blocker_id = (select uid()) or i_am_blocked(id));

drop policy if exists read_targets on block_targets;
create policy read_targets on block_targets for select using (
  i_declared(block_id)
  or exists (select 1 from cars c
              where c.plate_norm = block_targets.victim_plate_norm
                and c.owner_id = (select uid()))
);

drop policy if exists my_messages on messages;
create policy my_messages on messages for select using (
  to_user = (select uid()) or from_user = (select uid())
  or i_declared(block_id) or i_am_blocked(block_id)
);

drop policy if exists read_ads on ads;
create policy read_ads on ads for select
  using (active and now() between starts_at and ends_at);

drop policy if exists admin_ads on ads;
create policy admin_ads on ads for all using (is_admin()) with check (is_admin());

drop policy if exists admin_advertisers on advertisers;
create policy admin_advertisers on advertisers for all using (is_admin()) with check (is_admin());

-- ================= the verbs =================
-- Security definer, pinned search_path, and every one re-checks the caller.
-- Rationale for RPC-over-table-writes: db/README.md.

create or replace function declare_block(
  p_blocker_plate text,
  p_victims       text[],
  p_eta           int              default 15,
  p_lat           double precision default null,
  p_lng           double precision default null,
  p_accuracy_m    int              default null
) returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid    text := auth.user_id();
  v_plate  text := public.plate_norm(p_blocker_plate);
  v_block  uuid;
  v_raw    text;
  v_victim text;
  v_owner  text;
  v_count  int := 0;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  perform expire_blocks();

  if not exists (select 1 from cars where owner_id = v_uid and plate_norm = v_plate) then
    raise exception 'That car is not in your garage.' using errcode = '42501';
  end if;

  if p_eta not in (5, 15, 30, 60) then
    raise exception 'Pick 5, 15, 30 or 60 minutes.' using errcode = '22023';
  end if;

  insert into blocks (blocker_id, blocker_plate_norm, eta_minutes, lat, lng, accuracy_m, expires_at)
  values (v_uid, v_plate, p_eta, p_lat, p_lng, p_accuracy_m,
          now() + make_interval(mins => p_eta + 120))
  returning id into v_block;

  foreach v_raw in array coalesce(p_victims, array[]::text[]) loop
    v_victim := public.plate_norm(v_raw);
    continue when length(v_victim) < 4 or v_victim = v_plate;

    v_owner := null;
    select owner_id into v_owner from cars where plate_norm = v_victim;

    insert into block_targets (block_id, victim_plate_norm, victim_id, notified)
    values (v_block, v_victim, v_owner, v_owner is not null)
    on conflict (block_id, victim_plate_norm) do nothing;

    if v_owner is not null and v_owner <> v_uid then
      insert into messages (block_id, to_user, from_label, kind, body)
      values (v_block, v_owner, 'Blocked in', 'hot',
              v_plate || ' is parked behind your ' || v_victim ||
              '. Driver says back in ' || p_eta || ' min.');
      v_count := v_count + 1;
    end if;
  end loop;

  if not exists (select 1 from block_targets where block_id = v_block) then
    raise exception 'Enter the plate you are blocking.' using errcode = '22023';
  end if;

  return json_build_object('block_id', v_block, 'notified', v_count);
end $$;

create or replace function clear_block(p_block uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid   text := auth.user_id();
  v_plate text;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  select blocker_plate_norm into v_plate
    from blocks
   where id = p_block and blocker_id = v_uid and status in ('open', 'disputed');

  if v_plate is null then
    raise exception 'No open block of yours with that id.' using errcode = '42501';
  end if;

  update blocks set status = 'cleared', cleared_at = now() where id = p_block;
  delete from messages where block_id = p_block;

  insert into messages (block_id, to_user, from_label, kind, body)
  select distinct p_block, c.owner_id, 'All clear', 'cool',
         v_plate || ' has moved. You are free to go. Still stuck? Flag it below.'
    from block_targets t
    join cars c on c.plate_norm = t.victim_plate_norm
   where t.block_id = p_block and c.owner_id <> v_uid;

  return json_build_object('ok', true);
end $$;

create or replace function flag_block(p_block uuid, p_my_plate text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid  text := auth.user_id();
  v_mine text := public.plate_norm(p_my_plate);
  v_b    record;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  select * into v_b from blocks where id = p_block;
  if v_b.id is null or not is_block_target(p_block, v_mine) then
    raise exception 'That is not your block to flag.' using errcode = '42501';
  end if;

  if v_b.blocker_id = v_uid then
    raise exception 'You cannot flag your own block.' using errcode = '42501';
  end if;

  if v_b.status in ('open', 'disputed') then
    return json_build_object('ok', true, 'already_open', true);
  end if;

  update blocks
     set status     = 'disputed',
         cleared_at = null,
         expires_at = greatest(expires_at, now() + interval '1 hour')
   where id = p_block;

  delete from messages where block_id = p_block;

  insert into messages (block_id, to_user, from_label, kind, body)
  values (p_block, v_b.blocker_id, 'Still blocked', 'hot',
          'The driver of ' || v_mine || ' says ' || v_b.blocker_plate_norm ||
          ' is still there. Cleared too early — please move now.');

  insert into messages (block_id, to_user, from_label, kind, body)
  select distinct p_block, c.owner_id, 'Flagged', 'info',
         'We have told ' || v_b.blocker_plate_norm ||
         ' they are still blocking you. Logged against their record.'
    from block_targets t
    join cars c on c.plate_norm = t.victim_plate_norm
   where t.block_id = p_block
     and c.owner_id <> v_b.blocker_id
     and c.plate_norm <> v_mine;

  return json_build_object('ok', true);
end $$;

create or replace function contact_blocker(
  p_block    uuid,
  p_my_plate text,
  p_urgent   boolean default false
) returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid  text := auth.user_id();
  v_mine text := public.plate_norm(p_my_plate);
  v_b    record;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  select * into v_b from blocks where id = p_block and status in ('open', 'disputed');
  if v_b.id is null or not is_block_target(p_block, v_mine) then
    raise exception 'That block is not open, or it is not yours.' using errcode = '42501';
  end if;

  insert into messages (block_id, to_user, from_user, from_label, kind, body)
  values (p_block, v_b.blocker_id, v_uid, 'Reply from ' || v_mine,
          case when p_urgent then 'hot' else 'info' end,
          case when p_urgent
               then 'Please come now — I need to leave.'
               else 'No rush, just letting you know I am waiting.' end);

  return json_build_object('ok', true);
end $$;

create or replace function trace_block(p_blocker_plate text, p_my_plate text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid   text := auth.user_id();
  v_them  text := public.plate_norm(p_blocker_plate);
  v_mine  text := public.plate_norm(p_my_plate);
  v_tries int;
  v_hit   record;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  if length(v_them) < 4 or length(v_mine) < 4 then
    raise exception 'Check those plates.' using errcode = '22023';
  end if;

  select count(*) into v_tries
    from trace_attempts
   where user_id = v_uid and created_at > now() - interval '1 hour';

  if v_tries >= 10 then
    raise exception 'Too many traces this hour. Try again later.' using errcode = '53400';
  end if;

  insert into trace_attempts (user_id) values (v_uid);
  perform expire_blocks();

  select b.id, b.eta_minutes, b.declared_at, b.blocker_plate_norm
    into v_hit
    from blocks b
    join block_targets t on t.block_id = b.id
   where b.status in ('open', 'disputed')
     and b.blocker_plate_norm = v_them
     and t.victim_plate_norm  = v_mine
   order by b.declared_at desc
   limit 1;

  if v_hit.id is null then
    return json_build_object('found', false);
  end if;

  return json_build_object(
    'found',       true,
    'block_id',    v_hit.id,
    'eta',         v_hit.eta_minutes,
    'declared_at', v_hit.declared_at,
    'plate',       v_hit.blocker_plate_norm
  );
end $$;

create or replace function say(p_block uuid, p_my_plate text, p_body text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid   text := auth.user_id();
  v_body  text := btrim(coalesce(p_body, ''));
  v_mine  text := public.plate_norm(p_my_plate);
  v_b     record;
  v_count int;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if v_body = '' then
    raise exception 'Type something first.' using errcode = '22023';
  end if;
  if length(v_body) > 300 then
    raise exception 'Keep it under 300 characters.' using errcode = '22023';
  end if;

  select * into v_b from blocks where id = p_block and status in ('open','disputed');
  if v_b.id is null then
    raise exception 'That block is not open.' using errcode = '42501';
  end if;

  select count(*) into v_count from messages
   where block_id = p_block and from_user = v_uid and is_typed
     and created_at > now() - interval '10 minutes';
  if v_count >= 10 then
    raise exception 'Too many messages. Wait a moment.' using errcode = '53400';
  end if;

  if v_b.blocker_id = v_uid then
    insert into messages (block_id, to_user, from_user, from_label, kind, body, is_typed)
    select distinct p_block, c.owner_id, v_uid, v_b.blocker_plate_norm, 'info', v_body, true
      from block_targets t
      join cars c on c.plate_norm = t.victim_plate_norm
     where t.block_id = p_block and c.owner_id <> v_uid;
  else
    if not is_block_target(p_block, v_mine) then
      raise exception 'That block is not yours.' using errcode = '42501';
    end if;
    insert into messages (block_id, to_user, from_user, from_label, kind, body, is_typed)
    values (p_block, v_b.blocker_id, v_uid, v_mine, 'info', v_body, true);
  end if;

  return json_build_object('ok', true);
end $$;

create or replace function thread(p_block uuid)
returns table (
  id         uuid,
  from_label text,
  body       text,
  kind       text,
  is_typed   boolean,
  mine       boolean,
  created_at timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
declare v_uid text := auth.user_id();
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if not (i_declared(p_block) or i_am_blocked(p_block)) then
    raise exception 'That block is not yours.' using errcode = '42501';
  end if;

  return query
    select m.id, m.from_label, m.body, m.kind, m.is_typed,
           (m.from_user = v_uid), m.created_at
      from messages m
     where m.block_id = p_block
     order by m.created_at;
end $$;

-- ================= ads =================

create or replace function log_ad_event(p_ad uuid, p_slot text, p_event text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid   text := auth.user_id();
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

  if p_event = 'impression' and exists (
    select 1 from ad_events
     where ad_id = p_ad and user_id = v_uid and slot = p_slot and event = 'impression'
       and created_at > now() - interval '1 hour'
  ) then
    return json_build_object('ok', false, 'why', 'already counted');
  end if;

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

  select count(*) into v_total from ad_events
   where user_id = v_uid and created_at > now() - interval '1 hour';
  if v_total >= 120 then
    return json_build_object('ok', false, 'why', 'rate limited');
  end if;

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

create or replace function ad_report()
returns setof ad_performance
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  return query select * from ad_performance order by period desc, merchant;
end $$;

-- Totals only — nothing that identifies a person. Feeds the public About page.
create or replace function public_stats()
returns json language sql stable security definer
set search_path = public
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
                   select to_user from messages
                    where created_at > now() - interval '30 days' and to_user is not null
                 ) active)
  )
$$;

-- ================= web push =================
-- The browser side is the caller's own business (subscribe, unsubscribe, list
-- my devices). The sending side is the worker's: it calls push_drain after
-- every verb with a key only it holds, and gets back who to wake. Nobody else
-- can read another driver's push endpoint.

create or replace function push_subscribe(p_endpoint text, p_p256dh text, p_auth text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare v_uid text := auth.user_id();
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000
     or coalesce(length(p_p256dh), 0) not between 80 and 100
     or coalesce(length(p_auth), 0) not between 16 and 32 then
    raise exception 'That is not a push subscription.' using errcode = '22023';
  end if;

  insert into push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, v_uid, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;

  return json_build_object('ok', true);
end $$;

create or replace function push_unsubscribe(p_endpoint text)
returns json
language plpgsql security definer
set search_path = public
as $$
begin
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.user_id();
  return json_build_object('ok', true);
end $$;

-- The caller's own devices, for the "send me a test" button.
create or replace function push_mine()
returns table (endpoint text, p256dh text, auth text)
language plpgsql stable security definer
set search_path = public
as $$
-- public.uid(), not auth.user_id(): the output column `auth` would shadow the schema.
declare v_uid text := public.uid();
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  return query
    select s.endpoint, s.p256dh, s.auth from push_subscriptions s where s.user_id = v_uid;
end $$;

create or replace function push_key_ok(p_key text)
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from push_config
                  where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex'))
$$;

-- Claims every message not yet pushed and returns one row per device to wake.
-- Older than ten minutes is left alone: a stale "you're blocked" at 3am helps
-- nobody. skip locked lets two verbs finishing together drain without doubling.
create or replace function push_drain(p_key text)
returns table (endpoint text, p256dh text, auth text,
               block_id uuid, kind text, title text, body text)
language plpgsql security definer
set search_path = public
as $$
begin
  if not push_key_ok(p_key) then
    raise exception 'Not the worker.' using errcode = '42501';
  end if;

  return query
    with claimed as (
      update messages m set pushed_at = now()
       where m.id in (select x.id from messages x
                       where x.pushed_at is null and x.to_user is not null
                         and x.created_at > now() - interval '10 minutes'
                       for update skip locked)
      returning m.block_id, m.to_user, m.kind, m.from_label, m.body, m.is_typed
    )
    select s.endpoint, s.p256dh, s.auth, c.block_id, c.kind,
           case when c.is_typed then 'Message · ' || c.from_label else c.from_label end,
           c.body
      from claimed c
      join push_subscriptions s on s.user_id = c.to_user;
end $$;

-- The push service said 404/410: that browser unsubscribed or was wiped.
create or replace function push_gone(p_key text, p_endpoints text[])
returns json
language plpgsql security definer
set search_path = public
as $$
begin
  if not push_key_ok(p_key) then
    raise exception 'Not the worker.' using errcode = '42501';
  end if;
  delete from push_subscriptions where endpoint = any(p_endpoints);
  return json_build_object('ok', true);
end $$;

-- ================= grants =================
-- Start from nothing, then grant exactly what the client uses.

revoke all on all tables    in schema public from public, anonymous, authenticated;
revoke all on all sequences in schema public from public, anonymous, authenticated;
revoke execute on all functions in schema public from public, anonymous, authenticated;

grant usage on schema public to anonymous, authenticated;

-- profiles: is_admin is not client-writable.
grant select on profiles to authenticated;
grant insert (id, display_name, phone, avatar_url) on profiles to authenticated;
-- id is in the list because a PostgREST upsert sets every column it inserts;
-- the own_profile check still pins it to the caller.
grant update (id, display_name, phone, avatar_url) on profiles to authenticated;

-- cars: verified is not client-writable, and a plate is deleted, not edited.
grant select, delete on cars to authenticated;
grant insert (owner_id, plate, nickname) on cars to authenticated;
grant update (nickname)                  on cars to authenticated;

-- Everything else about a block goes through the verbs.
grant select on blocks, block_targets, messages to authenticated;

-- Admin surfaces; RLS restricts writes to is_admin.
grant select, insert, update, delete on ads, advertisers to authenticated;

grant execute on function
  declare_block(text, text[], int, double precision, double precision, int),
  clear_block(uuid),
  flag_block(uuid, text),
  contact_blocker(uuid, text, boolean),
  trace_block(text, text),
  say(uuid, text, text),
  thread(uuid),
  log_ad_event(uuid, text, text),
  ad_report(),
  push_subscribe(text, text, text),
  push_unsubscribe(text),
  push_mine(),
  -- Policy helpers: RLS evaluates them as the caller.
  uid(),
  i_declared(uuid),
  i_am_blocked(uuid),
  is_admin(),
  plate_norm(text)
to authenticated;

-- Drivers' phones sweep stale blocks before they read (no cron on a
-- scale-to-zero compute). It takes no arguments and only applies the rule above.
grant execute on function expire_blocks() to authenticated;

grant execute on function public_stats() to anonymous, authenticated;
-- The worker calls these with no session; the key argument is the gate.
grant execute on function push_drain(text), push_gone(text, text[]) to anonymous, authenticated;
