-- The four verbs end to end, as two drivers. Runs after schema.sql in CI;
-- any failed expectation raises, which fails the job. Rolled back at the end.
begin;

create function pg_temp.as_driver(p text) returns void language sql
as $$ select set_config('test.uid', p, true) $$;

create function pg_temp.expect(ok boolean, what text) returns void language plpgsql
as $$ begin if not ok then raise exception 'FAILED: %', what; end if; end $$;

do $$
declare r json; v_block uuid; n int;
begin
  insert into cars (owner_id, plate) values ('blocker', 'WXY 1234'), ('victim', 'abc 987');

  -- declare
  perform pg_temp.as_driver('blocker');
  r := declare_block('WXY1234', array['ABC 987', 'JJJ 1111'], 15);
  v_block := (r->>'block_id')::uuid;
  perform pg_temp.expect((r->>'notified')::int = 1, 'declare notifies the one registered victim');
  select count(*) into n from messages where block_id = v_block and to_user = 'victim' and kind = 'hot';
  perform pg_temp.expect(n = 1, 'victim gets a hot message');

  begin
    perform declare_block('NOT MINE 1', array['ABC987'], 15);
    perform pg_temp.expect(false, 'declare with a car not in the garage is refused');
  exception when insufficient_privilege then null; end;

  begin
    perform declare_block('WXY1234', array['ABC987'], 7);
    perform pg_temp.expect(false, 'declare refuses an eta outside 5/15/30/60');
  exception when invalid_parameter_value then null; end;

  -- trace (the victim, by the pair of plates)
  perform pg_temp.as_driver('victim');
  r := trace_block('wxy 1234', 'ABC987');
  perform pg_temp.expect((r->>'found')::boolean and (r->>'block_id')::uuid = v_block, 'trace finds the block');
  r := trace_block('WXY1234', 'ZZZ0000');
  perform pg_temp.expect(not (r->>'found')::boolean, 'trace with the wrong pair finds nothing');

  -- contact
  perform contact_blocker(v_block, 'ABC987', true);
  select count(*) into n from messages where block_id = v_block and to_user = 'blocker';
  perform pg_temp.expect(n = 1, 'contact reaches the blocker');

  -- clear
  begin
    perform clear_block(v_block);
    perform pg_temp.expect(false, 'only the blocker can clear');
  exception when insufficient_privilege then null; end;

  perform pg_temp.as_driver('blocker');
  perform clear_block(v_block);
  perform pg_temp.expect((select status from blocks where id = v_block) = 'cleared', 'clear closes the block');
  select count(*) into n from messages where block_id = v_block and to_user = 'victim' and kind = 'cool';
  perform pg_temp.expect(n = 1, 'victim is told it is clear');

  -- flag
  begin
    perform flag_block(v_block, 'WXY1234');
    perform pg_temp.expect(false, 'blocker cannot flag own block');
  exception when insufficient_privilege then null; end;

  perform pg_temp.as_driver('victim');
  perform flag_block(v_block, 'ABC987');
  perform pg_temp.expect((select status from blocks where id = v_block) = 'disputed', 'flag reopens as disputed');
  select count(*) into n from messages where block_id = v_block and to_user = 'blocker' and kind = 'hot';
  perform pg_temp.expect(n = 1, 'blocker is told they are still blocking');

  -- trace rate limit: 2 used above, 8 more allowed, the 11th refused
  for i in 1..8 loop perform trace_block('WXY1234', 'ABC987'); end loop;
  begin
    perform trace_block('WXY1234', 'ABC987');
    perform pg_temp.expect(false, 'trace is capped at 10 an hour');
  exception when configuration_limit_exceeded then null; end;

  -- signed out
  perform pg_temp.as_driver('');
  begin
    perform declare_block('WXY1234', array['ABC987'], 15);
    perform pg_temp.expect(false, 'signed-out declare is refused');
  exception when invalid_authorization_specification then null; end;

  -- expiry: time is up, or older than 24 hours, whether open or flagged
  insert into blocks (blocker_id, blocker_plate_norm, status, declared_at, expires_at) values
    ('e1', 'AAA1111', 'open',     now() - interval '3 hours',  now() - interval '1 hour'),
    ('e2', 'BBB2222', 'disputed', now() - interval '3 hours',  now() - interval '1 hour'),
    ('e3', 'CCC3333', 'disputed', now() - interval '25 hours', now() + interval '1 hour'),
    ('e4', 'DDD4444', 'open',     now() - interval '25 hours', now() + interval '1 hour'),
    ('e5', 'EEE5555', 'open',     now() - interval '30 minutes', now() + interval '2 hours'),
    ('e6', 'FFF6666', 'disputed', now() - interval '2 hours',  now() + interval '1 hour'),
    ('e7', 'GGG7777', 'cleared',  now() - interval '30 hours', now() - interval '27 hours');
  perform expire_blocks();
  perform pg_temp.expect((select status from blocks where blocker_id = 'e1') = 'expired', 'open block past its time expires');
  perform pg_temp.expect((select status from blocks where blocker_id = 'e2') = 'expired', 'flagged block past its time expires');
  perform pg_temp.expect((select status from blocks where blocker_id = 'e3') = 'expired', 'flagged block older than 24h expires');
  perform pg_temp.expect((select status from blocks where blocker_id = 'e4') = 'expired', 'open block older than 24h expires');
  perform pg_temp.expect((select status from blocks where blocker_id = 'e5') = 'open', 'a fresh open block stays open');
  perform pg_temp.expect((select status from blocks where blocker_id = 'e6') = 'disputed', 'a fresh flagged block stays flagged');
  perform pg_temp.expect((select status from blocks where blocker_id = 'e7') = 'cleared', 'a cleared block is left alone');

  raise notice 'verbs: all checks passed';
end $$;

rollback;
