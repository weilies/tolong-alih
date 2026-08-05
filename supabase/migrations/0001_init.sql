-- Tolong Alih — core schema
-- Run once per environment. Replace {{SCHEMA}} with alih_uat or alih_prod.

create schema if not exists {{SCHEMA}};

-- ---------------- profiles ----------------
create table if not exists {{SCHEMA}}.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  phone        text,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ---------------- cars ----------------
create table if not exists {{SCHEMA}}.cars (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  plate      text not null,
  plate_norm text generated always as (upper(regexp_replace(plate,'[^A-Za-z0-9]','','g'))) stored,
  nickname   text,
  verified   boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists cars_plate_norm_uniq on {{SCHEMA}}.cars (plate_norm);
create index if not exists cars_owner_idx on {{SCHEMA}}.cars (owner_id);

-- ---------------- blocks ----------------
create table if not exists {{SCHEMA}}.blocks (
  id                 uuid primary key default gen_random_uuid(),
  blocker_id         uuid not null references auth.users(id) on delete cascade,
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
create index if not exists blocks_status_idx  on {{SCHEMA}}.blocks (status, declared_at desc);
create index if not exists blocks_blocker_idx on {{SCHEMA}}.blocks (blocker_id);

-- ---------------- block targets (1..2 cars) ----------------
create table if not exists {{SCHEMA}}.block_targets (
  id                uuid primary key default gen_random_uuid(),
  block_id          uuid not null references {{SCHEMA}}.blocks(id) on delete cascade,
  victim_plate_norm text not null,
  victim_id         uuid references auth.users(id) on delete set null,
  notified          boolean not null default false
);
create unique index if not exists block_targets_uniq on {{SCHEMA}}.block_targets (block_id, victim_plate_norm);
create index if not exists block_targets_plate_idx on {{SCHEMA}}.block_targets (victim_plate_norm);

-- ---------------- messages ----------------
create table if not exists {{SCHEMA}}.messages (
  id         uuid primary key default gen_random_uuid(),
  block_id   uuid not null references {{SCHEMA}}.blocks(id) on delete cascade,
  to_user    uuid references auth.users(id) on delete cascade,
  from_label text not null,
  kind       text not null default 'info' check (kind in ('hot','info','cool')),
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_to_idx on {{SCHEMA}}.messages (to_user, created_at desc);

-- ---------------- ads ----------------
create table if not exists {{SCHEMA}}.ads (
  id         uuid primary key default gen_random_uuid(),
  merchant   text not null,
  mark       text not null default 'AD',
  headline   text not null,
  body       text not null,
  cta_url    text,
  lat        double precision,
  lng        double precision,
  radius_m   int not null default 3000,
  slots      text[] not null default array['interstitial','alert','trace'],
  daily_cap  int not null default 1000,
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz not null default (now() + interval '90 days'),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists ads_active_idx on {{SCHEMA}}.ads (active, starts_at, ends_at);

create table if not exists {{SCHEMA}}.ad_events (
  id         bigserial primary key,
  ad_id      uuid not null references {{SCHEMA}}.ads(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  slot       text not null,
  event      text not null check (event in ('impression','click')),
  created_at timestamptz not null default now()
);
create index if not exists ad_events_ad_idx on {{SCHEMA}}.ad_events (ad_id, created_at desc);

-- ================= RLS =================
alter table {{SCHEMA}}.profiles      enable row level security;
alter table {{SCHEMA}}.cars          enable row level security;
alter table {{SCHEMA}}.blocks        enable row level security;
alter table {{SCHEMA}}.block_targets enable row level security;
alter table {{SCHEMA}}.messages      enable row level security;
alter table {{SCHEMA}}.ads           enable row level security;
alter table {{SCHEMA}}.ad_events     enable row level security;

-- profiles: own row only
create policy own_profile on {{SCHEMA}}.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- cars: own cars only
create policy own_cars on {{SCHEMA}}.cars
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- blocks: visible to the blocker, or to a targeted victim
create policy read_blocks on {{SCHEMA}}.blocks for select using (
  blocker_id = auth.uid()
  or exists (
    select 1 from {{SCHEMA}}.block_targets t
    join {{SCHEMA}}.cars c on c.plate_norm = t.victim_plate_norm
    where t.block_id = blocks.id and c.owner_id = auth.uid()
  )
);
create policy write_blocks on {{SCHEMA}}.blocks
  for insert with check (blocker_id = auth.uid());
create policy update_blocks on {{SCHEMA}}.blocks
  for update using (blocker_id = auth.uid());

-- messages: addressed to me
create policy my_messages on {{SCHEMA}}.messages
  for select using (to_user = auth.uid());

-- ads: anyone signed in may read active ones; only admins write
create policy read_ads on {{SCHEMA}}.ads for select using (
  active and now() between starts_at and ends_at
);
create policy admin_ads on {{SCHEMA}}.ads for all using (
  exists (select 1 from {{SCHEMA}}.profiles p where p.id = auth.uid() and p.is_admin)
);

-- ad_events: insert-only from the client
create policy log_ad_events on {{SCHEMA}}.ad_events
  for insert with check (true);

-- ================= housekeeping =================
-- Auto-expire stale blocks. Schedule via pg_cron every 10 minutes.
create or replace function {{SCHEMA}}.expire_blocks() returns void
language sql security definer as $$
  update {{SCHEMA}}.blocks
     set status = 'expired'
   where status = 'open' and expires_at < now();
$$;
