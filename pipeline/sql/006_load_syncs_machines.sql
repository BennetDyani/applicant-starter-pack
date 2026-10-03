-- The pipeline now sends the cleaned machine list with each file, so machines are synced
-- in the same transaction as the events that reference them. Keeps security definer and
-- the pinned search_path from migrations 004 and 005.
create or replace function fleet.load_clean_file(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_file_id    integer;
  v_inserted   integer;
  v_clean      integer := jsonb_array_length(coalesce(p->'rows', '[]'));
  v_rejected   integer := jsonb_array_length(coalesce(p->'rejected', '[]'));
  v_run_id     bigint;
begin
  -- 0. Keep the machine list current (same transaction as the file).
  if jsonb_typeof(p->'machines') = 'array' then
    perform fleet.upsert_machines(p->'machines');
  end if;

  -- 1. Register the file (or note that it was loaded again).
  insert into fleet.source_files (file_name, delivery_date, data_date, checksum)
  values (p->'file'->>'file_name',
          nullif(p->'file'->>'delivery_date', '')::date,
          nullif(p->'file'->>'data_date', '')::date,
          p->'file'->>'checksum')
  on conflict (file_name) do update
    set last_loaded_at = now(),
        load_count     = fleet.source_files.load_count + 1,
        checksum       = excluded.checksum
  returning file_id into v_file_id;

  -- 2. Branches and drivers seen in the file.
  insert into fleet.branches (name)
  select distinct r->>'reported_branch' from jsonb_array_elements(p->'rows') r
  where r->>'reported_branch' is not null
  on conflict (name) do nothing;

  insert into fleet.drivers (driver_key, first_name, surname)
  select distinct on (r->'driver'->>'driver_key')
         r->'driver'->>'driver_key', r->'driver'->>'first_name', r->'driver'->>'surname'
  from jsonb_array_elements(p->'rows') r
  where jsonb_typeof(r->'driver') = 'object'
  on conflict (driver_key) do nothing;

  -- 3. Events. The natural key makes this safe to repeat.
  insert into fleet.events (ref_no, event_time, event_type, run_hours_seconds, driver_id,
                            event_branch_id, file_id, source_line, is_late_arrival, branch_mismatch)
  select r->>'ref_no',
         (r->>'event_time')::timestamp,
         r->>'event_type',
         (r->>'run_hours_seconds')::bigint,
         d.driver_id,
         b.branch_id,
         v_file_id,
         (r->>'source_line')::integer,
         coalesce((r->>'is_late_arrival')::boolean, false),
         coalesce((r->>'branch_mismatch')::boolean, false)
  from jsonb_array_elements(p->'rows') r
  join fleet.branches b on b.name = r->>'reported_branch'
  left join fleet.drivers d on d.driver_key = r->'driver'->>'driver_key'
  on conflict on constraint events_natural_key do nothing;
  get diagnostics v_inserted = row_count;

  -- 4. Rejected rows, with the reason.
  insert into fleet.rejected_rows (file_id, line_no, raw_line, reason, detail)
  select v_file_id, (x->>'line_no')::integer, x->>'raw_line', x->>'reason', x->>'detail'
  from jsonb_array_elements(coalesce(p->'rejected', '[]')) x
  on conflict on constraint rejected_rows_file_line do nothing;

  -- 5. Run log.
  insert into fleet.ingestion_runs (file_name, file_id, started_at, status, rows_read, rows_loaded,
                                    rows_already_loaded, rows_rejected, triggered_by)
  values (p->'file'->>'file_name', v_file_id,
          coalesce((p->'run'->>'started_at')::timestamptz, now()),
          'success',
          (p->'summary'->>'rows_read')::integer,
          v_inserted, v_clean - v_inserted, v_rejected,
          coalesce(p->'run'->>'triggered_by', 'schedule'))
  returning run_id into v_run_id;

  return jsonb_build_object('run_id', v_run_id, 'file_id', v_file_id, 'status', 'success',
                            'rows_read', (p->'summary'->>'rows_read')::integer,
                            'rows_loaded', v_inserted,
                            'rows_already_loaded', v_clean - v_inserted,
                            'rows_rejected', v_rejected);
end $$;

grant execute on function fleet.load_clean_file(jsonb) to fleet_pipeline;
