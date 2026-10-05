-- Ridgeback Logistics: run-level log (Task 2).
-- fleet.ingestion_runs keeps one row per file processed. This table adds one row per pipeline run,
-- written at the start of every run, so a scheduled run that finds no new files is still recorded.

create table if not exists fleet.pipeline_runs (
  run_id         bigint generated always as identity primary key,
  started_at     timestamptz not null unique,
  triggered_by   text not null,           -- 'schedule' or 'manual'
  files_seen     integer not null,        -- daily files found in the incoming folder
  files_to_load  integer not null,        -- new or changed files this run will load
  logged_at      timestamptz not null default now()
);

create or replace function fleet.log_pipeline_run(p_started_at timestamptz, p_triggered_by text,
                                                  p_files_seen integer, p_files_to_load integer)
returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into fleet.pipeline_runs (started_at, triggered_by, files_seen, files_to_load)
  values (p_started_at, coalesce(p_triggered_by, 'schedule'), p_files_seen, p_files_to_load)
  on conflict (started_at) do update set files_seen = excluded.files_seen, files_to_load = excluded.files_to_load
  returning run_id
$$;

revoke all on fleet.pipeline_runs from public;
revoke execute on function fleet.log_pipeline_run(timestamptz, text, integer, integer) from public;
grant execute on function fleet.log_pipeline_run(timestamptz, text, integer, integer) to fleet_pipeline;
grant select on fleet.pipeline_runs to fleet_reader;
