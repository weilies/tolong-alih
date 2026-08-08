-- Tolong Alih — break the blocks <-> block_targets policy recursion.
-- Run once per environment. Replace {{SCHEMA}} with app_alih_uat or app_alih_prod.
--
-- As shipped, read_blocks asked "is one of my cars a target of this block?" by
-- selecting from block_targets, and read_targets asked "did I declare this
-- block?" by selecting from blocks. Each policy triggered the other's policy,
-- so any select against either table died with:
--
--   42P17 infinite recursion detected in policy for relation "blocks"
--
-- The fix is to answer both questions inside security definer functions, which
-- run as the owner and therefore do not re-enter RLS. The predicates are
-- unchanged in meaning — only where they are evaluated changes.

create or replace function {{SCHEMA}}.i_declared(p_block uuid)
returns boolean language sql stable security definer
set search_path = {{SCHEMA}}, public
as $$
  select exists (
    select 1 from blocks
     where id = p_block and blocker_id = auth.uid()
  )
$$;

create or replace function {{SCHEMA}}.i_am_blocked(p_block uuid)
returns boolean language sql stable security definer
set search_path = {{SCHEMA}}, public
as $$
  select exists (
    select 1
      from block_targets t
      join cars c on c.plate_norm = t.victim_plate_norm
     where t.block_id = p_block and c.owner_id = auth.uid()
  )
$$;

-- Both helpers only ever report on the caller's own relationship to a block, so
-- exposing them to authenticated leaks nothing about anyone else.
revoke execute on function
  {{SCHEMA}}.i_declared(uuid), {{SCHEMA}}.i_am_blocked(uuid) from public, anon;
grant execute on function
  {{SCHEMA}}.i_declared(uuid), {{SCHEMA}}.i_am_blocked(uuid) to authenticated;

drop policy if exists read_blocks on {{SCHEMA}}.blocks;
create policy read_blocks on {{SCHEMA}}.blocks for select using (
  blocker_id = auth.uid() or {{SCHEMA}}.i_am_blocked(id)
);

drop policy if exists read_targets on {{SCHEMA}}.block_targets;
create policy read_targets on {{SCHEMA}}.block_targets for select using (
  {{SCHEMA}}.i_declared(block_id)
  or exists (
    select 1 from {{SCHEMA}}.cars c
     where c.plate_norm = block_targets.victim_plate_norm
       and c.owner_id = auth.uid()
  )
);

-- Same recursion on insert: the check selected from blocks.
drop policy if exists write_targets on {{SCHEMA}}.block_targets;
create policy write_targets on {{SCHEMA}}.block_targets for insert with check (
  {{SCHEMA}}.i_declared(block_id)
);
