-- Tolong Alih — let the two drivers actually talk.
-- Run once per environment. Replace {{SCHEMA}} with app_alih_uat or app_alih_prod.
--
-- Until now a blocked driver could send two canned lines and the blocker could
-- not reply at all, which leaves the obvious cases unserved: "give me two
-- minutes, I'm paying", "I'm at the back, come to the side door". Both sides can
-- now type. It still routes through the platform, so neither ever learns the
-- other's number.
--
-- Messages already carry to_user. from_user is added so the client can tell
-- which side of the thread a line belongs on, and is_typed marks a human line
-- apart from the system notices the other functions write.

alter table {{SCHEMA}}.messages
  add column if not exists from_user uuid references auth.users(id) on delete set null,
  add column if not exists is_typed  boolean not null default false;

create index if not exists messages_block_idx
  on {{SCHEMA}}.messages (block_id, created_at);

-- Both parties need to read the whole thread, not only the lines addressed to
-- them, or a conversation reads as half a conversation.
drop policy if exists my_messages on {{SCHEMA}}.messages;
create policy my_messages on {{SCHEMA}}.messages for select using (
  to_user = auth.uid()
  or from_user = auth.uid()
  or {{SCHEMA}}.i_declared(block_id)
  or {{SCHEMA}}.i_am_blocked(block_id)
);

create or replace function {{SCHEMA}}.say(
  p_block    uuid,
  p_my_plate text,
  p_body     text
) returns json
language plpgsql security definer
set search_path = {{SCHEMA}}, public
as $$
declare
  v_uid   uuid := auth.uid();
  v_body  text := btrim(coalesce(p_body, ''));
  v_mine  text := {{SCHEMA}}.plate_norm(p_my_plate);
  v_b     record;
  v_count int;
  v_label text;
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

  -- Chat is bounded so it cannot become a messaging app, or a way to harass
  -- someone you have never met.
  select count(*) into v_count from messages
   where block_id = p_block and from_user = v_uid and is_typed
     and created_at > now() - interval '10 minutes';
  if v_count >= 10 then
    raise exception 'Too many messages. Wait a moment.' using errcode = '53400';
  end if;

  if v_b.blocker_id = v_uid then
    -- The blocker replies to everyone they have boxed in.
    v_label := v_b.blocker_plate_norm;
    insert into messages (block_id, to_user, from_user, from_label, kind, body, is_typed)
    select distinct p_block, c.owner_id, v_uid, v_label, 'info', v_body, true
      from block_targets t
      join cars c on c.plate_norm = t.victim_plate_norm
     where t.block_id = p_block and c.owner_id <> v_uid;
  else
    if not {{SCHEMA}}.is_block_target(p_block, v_mine) then
      raise exception 'That block is not yours.' using errcode = '42501';
    end if;
    v_label := v_mine;
    insert into messages (block_id, to_user, from_user, from_label, kind, body, is_typed)
    values (p_block, v_b.blocker_id, v_uid, v_label, 'info', v_body, true);
  end if;

  return json_build_object('ok', true);
end $$;

revoke execute on function {{SCHEMA}}.say(uuid, text, text) from public, anon;
grant execute on function {{SCHEMA}}.say(uuid, text, text) to authenticated;

-- The thread for one block, oldest first, for both parties.
create or replace function {{SCHEMA}}.thread(p_block uuid)
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
set search_path = {{SCHEMA}}, public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if not ({{SCHEMA}}.i_declared(p_block) or {{SCHEMA}}.i_am_blocked(p_block)) then
    raise exception 'That block is not yours.' using errcode = '42501';
  end if;

  return query
    select m.id, m.from_label, m.body, m.kind, m.is_typed,
           (m.from_user = v_uid) as mine, m.created_at
      from messages m
     where m.block_id = p_block
     order by m.created_at;
end $$;

revoke execute on function {{SCHEMA}}.thread(uuid) from public, anon;
grant execute on function {{SCHEMA}}.thread(uuid) to authenticated;
