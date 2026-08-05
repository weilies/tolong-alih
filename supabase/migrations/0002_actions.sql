-- Tolong Alih — the four verbs, server side.
-- Run once per environment. Replace {{SCHEMA}} with app_alih_uat or app_alih_prod.
--
-- Why functions instead of straight table writes from the client:
--
--   flag   a blocked driver has to reopen someone else's block, and the
--          update_blocks policy is blocker-only by design.
--   trace  the whole point is that the blocked driver is NOT registered, so
--          read_blocks can never match them.
--   declare / clear  both write messages to the other party, and the only way
--          to allow that from the client was messages.send_messages, which was
--          `with check (true)` — i.e. anyone could forge a message to anyone,
--          from any label. That policy is dropped at the bottom of this file.
--
-- Every function is security definer, pinned to this schema, and re-checks the
-- caller. Knowing a block's uuid plus one of its plates is what proves you are
-- party to it — that pair is exactly what trace establishes.

-- ---------------- helpers ----------------

create or replace function {{SCHEMA}}.plate_norm(p text)
returns text language sql immutable
set search_path = ''
as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

-- Is the caller party to this block, on the victim side?
-- True when the named plate really is one of the block's targets AND either the
-- caller owns that plate, or they know the pair well enough to have traced it.
create or replace function {{SCHEMA}}.is_block_target(p_block uuid, p_plate text)
returns boolean language sql stable security definer
set search_path = {{SCHEMA}}, public
as $$
  select exists (
    select 1 from block_targets t
     where t.block_id = p_block
       and t.victim_plate_norm = {{SCHEMA}}.plate_norm(p_plate)
  )
$$;

-- ---------------- trace rate limiting ----------------
-- Without a cap, trace degrades into plate enumeration.

create table if not exists {{SCHEMA}}.trace_attempts (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists trace_attempts_user_idx
  on {{SCHEMA}}.trace_attempts (user_id, created_at desc);

-- RLS on, no policies: reachable only through trace_block() below.
alter table {{SCHEMA}}.trace_attempts enable row level security;

-- ---------------- declare ----------------

create or replace function {{SCHEMA}}.declare_block(
  p_blocker_plate text,
  p_victims       text[],
  p_eta           int              default 15,
  p_lat           double precision default null,
  p_lng           double precision default null,
  p_accuracy_m    int              default null
) returns json
language plpgsql security definer
set search_path = {{SCHEMA}}, public
as $$
declare
  v_uid    uuid := auth.uid();
  v_plate  text := {{SCHEMA}}.plate_norm(p_blocker_plate);
  v_block  uuid;
  v_raw    text;
  v_victim text;
  v_owner  uuid;
  v_count  int := 0;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  -- You may only declare from a car in your own garage.
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
    v_victim := {{SCHEMA}}.plate_norm(v_raw);
    continue when length(v_victim) < 4 or v_victim = v_plate;

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

-- ---------------- clear ----------------
-- No confirmation from the other side: the blocked driver may be streets away.

create or replace function {{SCHEMA}}.clear_block(p_block uuid)
returns json
language plpgsql security definer
set search_path = {{SCHEMA}}, public
as $$
declare
  v_uid   uuid := auth.uid();
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

  -- Resolve owners now rather than trusting block_targets.victim_id, which was
  -- written at declare time and is null for anyone who registered since.
  insert into messages (block_id, to_user, from_label, kind, body)
  select distinct p_block, c.owner_id, 'All clear', 'cool',
         v_plate || ' has moved. You are free to go. Still stuck? Flag it below.'
    from block_targets t
    join cars c on c.plate_norm = t.victim_plate_norm
   where t.block_id = p_block and c.owner_id <> v_uid;

  return json_build_object('ok', true);
end $$;

-- ---------------- flag ----------------
-- The blocker said they moved and they have not.

create or replace function {{SCHEMA}}.flag_block(p_block uuid, p_my_plate text)
returns json
language plpgsql security definer
set search_path = {{SCHEMA}}, public
as $$
declare
  v_uid  uuid := auth.uid();
  v_mine text := {{SCHEMA}}.plate_norm(p_my_plate);
  v_b    record;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  select * into v_b from blocks where id = p_block;
  if v_b.id is null or not {{SCHEMA}}.is_block_target(p_block, v_mine) then
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

  -- Anyone else caught behind the same car hears about it too.
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

-- ---------------- contact the blocker ----------------

create or replace function {{SCHEMA}}.contact_blocker(
  p_block    uuid,
  p_my_plate text,
  p_urgent   boolean default false
) returns json
language plpgsql security definer
set search_path = {{SCHEMA}}, public
as $$
declare
  v_uid  uuid := auth.uid();
  v_mine text := {{SCHEMA}}.plate_norm(p_my_plate);
  v_b    record;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;

  select * into v_b from blocks where id = p_block and status in ('open', 'disputed');
  if v_b.id is null or not {{SCHEMA}}.is_block_target(p_block, v_mine) then
    raise exception 'That block is not open, or it is not yours.' using errcode = '42501';
  end if;

  insert into messages (block_id, to_user, from_label, kind, body)
  values (p_block, v_b.blocker_id, 'Reply from ' || v_mine,
          case when p_urgent then 'hot' else 'info' end,
          case when p_urgent
               then 'Please come now — I need to leave.'
               else 'No rush, just letting you know I am waiting.' end);

  return json_build_object('ok', true);
end $$;

-- ---------------- trace ----------------
-- Both plates required, and capped per user per hour. Needing the pair is what
-- keeps this from being a plate-lookup tool; the cap is what keeps it from
-- being a slow one.

create or replace function {{SCHEMA}}.trace_block(p_blocker_plate text, p_my_plate text)
returns json
language plpgsql security definer
set search_path = {{SCHEMA}}, public
as $$
declare
  v_uid   uuid := auth.uid();
  v_them  text := {{SCHEMA}}.plate_norm(p_blocker_plate);
  v_mine  text := {{SCHEMA}}.plate_norm(p_my_plate);
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

-- ---------------- housekeeping ----------------

-- Same body as 0001, with the search_path pinned.
create or replace function {{SCHEMA}}.expire_blocks() returns void
language sql security definer
set search_path = ''
as $$
  update {{SCHEMA}}.blocks
     set status = 'expired'
   where status = 'open' and expires_at < now();
$$;

-- ---------------- grants ----------------

-- Clients write messages only through the functions above.
drop policy if exists send_messages on {{SCHEMA}}.messages;

grant usage on schema {{SCHEMA}} to anon, authenticated;

revoke execute on function
  {{SCHEMA}}.declare_block(text, text[], int, double precision, double precision, int),
  {{SCHEMA}}.clear_block(uuid),
  {{SCHEMA}}.flag_block(uuid, text),
  {{SCHEMA}}.contact_blocker(uuid, text, boolean),
  {{SCHEMA}}.trace_block(text, text),
  {{SCHEMA}}.is_block_target(uuid, text),
  {{SCHEMA}}.expire_blocks()
from public, anon;

grant execute on function
  {{SCHEMA}}.declare_block(text, text[], int, double precision, double precision, int),
  {{SCHEMA}}.clear_block(uuid),
  {{SCHEMA}}.flag_block(uuid, text),
  {{SCHEMA}}.contact_blocker(uuid, text, boolean),
  {{SCHEMA}}.trace_block(text, text)
to authenticated;
