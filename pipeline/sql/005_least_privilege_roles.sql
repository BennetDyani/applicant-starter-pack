-- Least-privilege database roles.
--   fleet_pipeline: used by the n8n ingestion workflow. Can only call the load functions
--                   and read which files were loaded. It cannot write to tables directly.
--   fleet_reader:   used by the dashboard API and the chat tools. Read-only, with a
--                   10-second statement timeout.
-- Passwords are set separately in the Supabase SQL editor and never committed:
--   alter role fleet_pipeline with password '<strong password>';
--   alter role fleet_reader   with password '<strong password>';

-- Load functions run with their owner's rights, so callers need EXECUTE only.
alter function fleet.upsert_machines(jsonb) security definer;
alter function fleet.load_clean_file(jsonb) security definer;
alter function fleet.log_failed_run(text, text, timestamptz, text) security definer;
revoke execute on all functions in schema fleet from public;

do $$
begin
  if not exists (select from pg_roles where rolname = 'fleet_pipeline') then
    create role fleet_pipeline login;
  end if;
  if not exists (select from pg_roles where rolname = 'fleet_reader') then
    create role fleet_reader login;
  end if;
end $$;

grant usage on schema fleet to fleet_pipeline, fleet_reader;

grant execute on function fleet.upsert_machines(jsonb) to fleet_pipeline;
grant execute on function fleet.load_clean_file(jsonb) to fleet_pipeline;
grant execute on function fleet.log_failed_run(text, text, timestamptz, text) to fleet_pipeline;
grant select on fleet.source_files, fleet.ingestion_runs to fleet_pipeline;

grant select on all tables in schema fleet to fleet_reader;
alter default privileges in schema fleet grant select on tables to fleet_reader;

alter role fleet_reader set default_transaction_read_only = on;
alter role fleet_reader set statement_timeout = '10s';
