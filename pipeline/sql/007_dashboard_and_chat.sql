-- Read-only functions used by the dashboard API and by the chat agent's tools (Task 3).
-- They all read the same views as each other, so the dashboard and the chat can never disagree.
-- Every function is SECURITY INVOKER and is executed by the read-only role fleet_reader.
-- Parameters are optional: NULL means "no filter"; dates default to the full range of data.

-- Helper: normalise optional filter values coming from the LLM ("forklifts" -> "Forklift").
create or replace function fleet.norm_machine_type(p text) returns text
language sql immutable as $$
  select case
    when p is null or btrim(p) = '' then null
    when lower(p) like 'fork%'  then 'Forklift'
    when lower(p) like 'reach%' then 'Reach Truck'
    when lower(p) like 'ppt%' or lower(p) like 'pallet%' then 'PPT'
    else '__unknown__' end
$$;

create or replace function fleet.norm_event_type(p text) returns text
language sql immutable as $$
  select case
    when p is null or btrim(p) = '' then null
    when lower(p) like '%impact%'                         then 'IMPACT'
    when lower(p) like '%brak%'                           then 'HARSH_BRAKING'
    when lower(p) like '%accel%'                          then 'HARSH_ACCELERATION'
    when lower(p) like '%speed%'                          then 'SPEEDING'
    when lower(p) like '%idl%'                            then 'EXCESS_IDLE'
    when lower(p) like '%power%'                          then 'POWER_UP'
    when lower(p) like '%driver change%' or lower(p) like '%log%' then 'DRIVER_CHANGE'
    else '__unknown__' end
$$;

-- 1. Which days have data. The agent uses this to turn "Tuesday" or "this week" into dates.
create or replace function fleet.chat_data_coverage()
returns table (event_date date, day_name text, events bigint, active_machines bigint)
language sql stable as $$
  select e.event_date, trim(to_char(e.event_date, 'Day')),
         count(*) filter (where et.counts_as_event), count(distinct e.ref_no)
  from fleet.events e join fleet.event_types et on et.code = e.event_type
  group by e.event_date order by e.event_date
$$;

-- 2. Run hours per machine over a date range, highest first.
create or replace function fleet.chat_machine_run_hours(
  p_date_from date default null, p_date_to date default null,
  p_machine_type text default null, p_branch text default null, p_ref_no text default null)
returns table (ref_no text, machine_type text, home_branch text, run_hours numeric, days_with_activity bigint)
language sql stable as $$
  select h.ref_no, h.machine_type, h.home_branch,
         round(sum(h.run_seconds) / 3600.0, 2), count(*) filter (where h.run_seconds > 0)
  from fleet.v_machine_daily_hours h
  where h.event_date between coalesce(p_date_from, '-infinity'::date) and coalesce(p_date_to, 'infinity'::date)
    and (fleet.norm_machine_type(p_machine_type) is null or h.machine_type = fleet.norm_machine_type(p_machine_type))
    and (p_branch is null or btrim(p_branch) = '' or lower(h.home_branch) = lower(btrim(p_branch)))
    and (p_ref_no is null or btrim(p_ref_no) = '' or h.ref_no = upper(btrim(p_ref_no)))
  group by h.ref_no, h.machine_type, h.home_branch
  order by 4 desc
$$;

-- 3. Safety events and run hours per driver, ranked by the requested event type (or all safety events).
create or replace function fleet.chat_driver_activity(
  p_date_from date default null, p_date_to date default null,
  p_event_type text default null, p_branch text default null, p_driver_name text default null)
returns table (driver_name text, impacts bigint, harsh_braking bigint, harsh_acceleration bigint,
               speeding bigint, excess_idle bigint, total_safety_events bigint, run_hours numeric)
language sql stable as $$
  with ev as (
    select c.driver_name, c.driver_id,
           sum(c.event_count) filter (where c.event_type = 'IMPACT')             as impacts,
           sum(c.event_count) filter (where c.event_type = 'HARSH_BRAKING')      as harsh_braking,
           sum(c.event_count) filter (where c.event_type = 'HARSH_ACCELERATION') as harsh_acceleration,
           sum(c.event_count) filter (where c.event_type = 'SPEEDING')           as speeding,
           sum(c.event_count) filter (where c.event_type = 'EXCESS_IDLE')        as excess_idle,
           sum(c.event_count) filter (where c.is_safety_event)                   as total_safety
    from fleet.v_event_counts c
    where c.event_date between coalesce(p_date_from, '-infinity'::date) and coalesce(p_date_to, 'infinity'::date)
      and (p_branch is null or btrim(p_branch) = '' or lower(c.event_branch) = lower(btrim(p_branch)))
    group by c.driver_name, c.driver_id
  ), hrs as (
    select dh.driver_id, sum(dh.run_hours) as run_hours
    from fleet.v_driver_daily_hours dh
    where dh.event_date between coalesce(p_date_from, '-infinity'::date) and coalesce(p_date_to, 'infinity'::date)
    group by dh.driver_id
  )
  select ev.driver_name,
         coalesce(ev.impacts, 0), coalesce(ev.harsh_braking, 0), coalesce(ev.harsh_acceleration, 0),
         coalesce(ev.speeding, 0), coalesce(ev.excess_idle, 0), coalesce(ev.total_safety, 0),
         coalesce(round(hrs.run_hours, 2), 0)
  from ev left join hrs on hrs.driver_id is not distinct from ev.driver_id
  where (p_driver_name is null or btrim(p_driver_name) = '' or ev.driver_name ilike '%' || btrim(p_driver_name) || '%')
  order by case fleet.norm_event_type(p_event_type)
             when 'IMPACT' then coalesce(ev.impacts, 0)
             when 'HARSH_BRAKING' then coalesce(ev.harsh_braking, 0)
             when 'HARSH_ACCELERATION' then coalesce(ev.harsh_acceleration, 0)
             when 'SPEEDING' then coalesce(ev.speeding, 0)
             when 'EXCESS_IDLE' then coalesce(ev.excess_idle, 0)
             else coalesce(ev.total_safety, 0) end desc,
           ev.driver_name
$$;

-- 4. Per branch: run hours, active machines and safety events.
create or replace function fleet.chat_branch_summary(p_date_from date default null, p_date_to date default null)
returns table (branch text, run_hours numeric, active_machines bigint, impacts bigint, harsh_braking bigint,
               harsh_acceleration bigint, speeding bigint, excess_idle bigint, total_safety_events bigint)
language sql stable as $$
  with hrs as (
    select h.operating_branch as branch, round(sum(h.run_seconds) / 3600.0, 2) as run_hours,
           count(distinct h.ref_no) filter (where h.run_seconds > 0) as active_machines
    from fleet.v_machine_daily_hours h
    where h.event_date between coalesce(p_date_from, '-infinity'::date) and coalesce(p_date_to, 'infinity'::date)
    group by h.operating_branch
  ), ev as (
    select c.event_branch as branch,
           sum(c.event_count) filter (where c.event_type = 'IMPACT')             as impacts,
           sum(c.event_count) filter (where c.event_type = 'HARSH_BRAKING')      as harsh_braking,
           sum(c.event_count) filter (where c.event_type = 'HARSH_ACCELERATION') as harsh_acceleration,
           sum(c.event_count) filter (where c.event_type = 'SPEEDING')           as speeding,
           sum(c.event_count) filter (where c.event_type = 'EXCESS_IDLE')        as excess_idle,
           sum(c.event_count) filter (where c.is_safety_event)                   as total_safety
    from fleet.v_event_counts c
    where c.event_date between coalesce(p_date_from, '-infinity'::date) and coalesce(p_date_to, 'infinity'::date)
    group by c.event_branch
  )
  select b.name, coalesce(hrs.run_hours, 0), coalesce(hrs.active_machines, 0),
         coalesce(ev.impacts, 0), coalesce(ev.harsh_braking, 0), coalesce(ev.harsh_acceleration, 0),
         coalesce(ev.speeding, 0), coalesce(ev.excess_idle, 0), coalesce(ev.total_safety, 0)
  from fleet.branches b
  left join hrs on hrs.branch = b.name
  left join ev  on ev.branch  = b.name
  order by b.name
$$;

-- 5. Safety events per machine, ranked by the requested event type (or all safety events).
create or replace function fleet.chat_machine_events(
  p_date_from date default null, p_date_to date default null, p_event_type text default null,
  p_machine_type text default null, p_branch text default null, p_ref_no text default null)
returns table (ref_no text, machine_type text, home_branch text, impacts bigint, harsh_braking bigint,
               harsh_acceleration bigint, speeding bigint, excess_idle bigint, total_safety_events bigint)
language sql stable as $$
  with per_machine as (
    select m.ref_no, m.machine_type, hb.name as home_branch,
           coalesce(sum(c.event_count) filter (where c.event_type = 'IMPACT'), 0)             as impacts,
           coalesce(sum(c.event_count) filter (where c.event_type = 'HARSH_BRAKING'), 0)      as harsh_braking,
           coalesce(sum(c.event_count) filter (where c.event_type = 'HARSH_ACCELERATION'), 0) as harsh_acceleration,
           coalesce(sum(c.event_count) filter (where c.event_type = 'SPEEDING'), 0)           as speeding,
           coalesce(sum(c.event_count) filter (where c.event_type = 'EXCESS_IDLE'), 0)        as excess_idle,
           coalesce(sum(c.event_count) filter (where c.is_safety_event), 0)                   as total_safety
    from fleet.machines m
    join fleet.branches hb on hb.branch_id = m.home_branch_id
    left join fleet.v_event_counts c
           on c.ref_no = m.ref_no
          and c.event_date between coalesce(p_date_from, '-infinity'::date) and coalesce(p_date_to, 'infinity'::date)
    where (fleet.norm_machine_type(p_machine_type) is null or m.machine_type = fleet.norm_machine_type(p_machine_type))
      and (p_branch is null or btrim(p_branch) = '' or lower(hb.name) = lower(btrim(p_branch)))
      and (p_ref_no is null or btrim(p_ref_no) = '' or m.ref_no = upper(btrim(p_ref_no)))
    group by m.ref_no, m.machine_type, hb.name
  )
  select * from per_machine
  order by case fleet.norm_event_type(p_event_type)
             when 'IMPACT' then impacts when 'HARSH_BRAKING' then harsh_braking
             when 'HARSH_ACCELERATION' then harsh_acceleration when 'SPEEDING' then speeding
             when 'EXCESS_IDLE' then excess_idle else total_safety end desc,
           ref_no
$$;

-- 6. Pipeline health: latest run per file and rejected rows by reason.
create or replace function fleet.chat_data_quality()
returns table (file_name text, data_day date, status text, rows_read integer, rows_loaded integer,
               rows_rejected integer, rejection_reasons text, last_run_at timestamptz)
language sql stable as $$
  select r.file_name, sf.data_date, r.status, r.rows_read, r.rows_loaded + coalesce(r.rows_already_loaded, 0),
         r.rows_rejected,
         (select string_agg(x.reason || ' (' || x.rows_rejected || ')', ', ' order by x.rows_rejected desc)
            from fleet.v_rejections_by_reason x where x.file_name = r.file_name),
         r.finished_at
  from fleet.v_latest_runs r
  left join fleet.source_files sf on sf.file_name = r.file_name
  order by r.file_name
$$;

-- 7. Everything the dashboard needs, in one call. Optional date range; defaults to all data.
create or replace function fleet.dashboard_snapshot(p_date_from date default null, p_date_to date default null)
returns jsonb language sql stable as $$
  with rng as (
    select coalesce(p_date_from, min(event_date)) as d_from, coalesce(p_date_to, max(event_date)) as d_to
    from fleet.events
  ),
  mh as (select * from fleet.chat_machine_run_hours((select d_from from rng), (select d_to from rng))),
  ev as (
    select c.* from fleet.v_event_counts c, rng
    where c.event_date between rng.d_from and rng.d_to
  )
  select jsonb_build_object(
    'generated_at', now(),
    'period', (select jsonb_build_object('from', d_from, 'to', d_to) from rng),
    'kpis', jsonb_build_object(
      'run_hours',        (select coalesce(round(sum(run_hours), 1), 0) from mh),
      'active_machines',  (select count(*) from mh where run_hours > 0),
      'total_machines',   (select count(*) from fleet.machines),
      'safety_events',    (select coalesce(sum(event_count), 0) from ev where is_safety_event),
      'impacts',          (select coalesce(sum(event_count), 0) from ev where event_type = 'IMPACT'),
      'active_drivers',   (select count(distinct driver_id) from ev where driver_id is not null)
    ),
    'daily_hours_by_branch', (
      select coalesce(jsonb_agg(jsonb_build_object('date', d.event_date, 'day', d.day_name,
                                                   'branch', d.operating_branch, 'hours', d.hours)
                                order by d.event_date, d.operating_branch), '[]'::jsonb)
      from (select h.event_date, h.day_name, h.operating_branch, round(sum(h.run_seconds) / 3600.0, 1) as hours
            from fleet.v_machine_daily_hours h, rng
            where h.event_date between rng.d_from and rng.d_to
            group by h.event_date, h.day_name, h.operating_branch) d
    ),
    'machine_hours', (
      select coalesce(jsonb_agg(jsonb_build_object('ref_no', ref_no, 'type', machine_type, 'branch', home_branch,
                                                   'hours', run_hours) order by run_hours desc), '[]'::jsonb)
      from (select m.ref_no, m.machine_type, hb.name as home_branch, coalesce(mh.run_hours, 0) as run_hours
            from fleet.machines m join fleet.branches hb on hb.branch_id = m.home_branch_id
            left join mh on mh.ref_no = m.ref_no) x
    ),
    'safety_by_branch', (
      select coalesce(jsonb_agg(jsonb_build_object('branch', branch, 'impacts', impacts, 'harsh_braking', harsh_braking,
                                                   'harsh_acceleration', harsh_acceleration, 'speeding', speeding,
                                                   'excess_idle', excess_idle, 'total', total_safety_events)
                                order by branch), '[]'::jsonb)
      from fleet.chat_branch_summary((select d_from from rng), (select d_to from rng))
    ),
    'top_drivers', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.total_safety_events desc, t.impacts desc), '[]'::jsonb)
      from (select * from fleet.chat_driver_activity((select d_from from rng), (select d_to from rng))
            where driver_name <> 'No driver logged on' limit 8) t
    ),
    'data_quality', jsonb_build_object(
      'files', (select coalesce(jsonb_agg(to_jsonb(q) order by q.file_name), '[]'::jsonb) from fleet.chat_data_quality() q),
      'rows_rejected', (select count(*) from fleet.rejected_rows),
      'last_run_at', (select max(finished_at) from fleet.ingestion_runs),
      'events_without_driver', (select coalesce(sum(event_count), 0) from ev where is_safety_event and driver_id is null)
    )
  )
$$;

-- Access for the read-only role.
grant execute on function fleet.norm_machine_type(text), fleet.norm_event_type(text),
  fleet.chat_data_coverage(), fleet.chat_machine_run_hours(date, date, text, text, text),
  fleet.chat_driver_activity(date, date, text, text, text), fleet.chat_branch_summary(date, date),
  fleet.chat_machine_events(date, date, text, text, text, text), fleet.chat_data_quality(),
  fleet.dashboard_snapshot(date, date)
  to fleet_reader;

revoke execute on function fleet.norm_machine_type(text), fleet.norm_event_type(text),
  fleet.chat_data_coverage(), fleet.chat_machine_run_hours(date, date, text, text, text),
  fleet.chat_driver_activity(date, date, text, text, text), fleet.chat_branch_summary(date, date),
  fleet.chat_machine_events(date, date, text, text, text, text), fleet.chat_data_quality(),
  fleet.dashboard_snapshot(date, date)
  from public;

-- Pin search_path (Supabase advisor 0011); everything inside is schema-qualified.
alter function fleet.norm_machine_type(text) set search_path = '';
alter function fleet.norm_event_type(text) set search_path = '';
alter function fleet.chat_data_coverage() set search_path = '';
alter function fleet.chat_machine_run_hours(date, date, text, text, text) set search_path = '';
alter function fleet.chat_driver_activity(date, date, text, text, text) set search_path = '';
alter function fleet.chat_branch_summary(date, date) set search_path = '';
alter function fleet.chat_machine_events(date, date, text, text, text, text) set search_path = '';
alter function fleet.chat_data_quality() set search_path = '';
alter function fleet.dashboard_snapshot(date, date) set search_path = '';
