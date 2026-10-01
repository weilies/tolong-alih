-- What Neon provides and a stock Postgres does not, so db/schema.sql can be
-- applied to a throwaway database in CI. Not for any real branch.
--
-- auth.user_id() is pg_session_jwt's; here it reads a session setting the
-- tests flip between drivers with set_config('test.uid', ...).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anonymous') then create role anonymous nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
create or replace function auth.user_id() returns text language sql stable
as $$ select nullif(current_setting('test.uid', true), '') $$;
