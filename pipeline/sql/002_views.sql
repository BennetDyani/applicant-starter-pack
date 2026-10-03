-- Views used by the dashboard and the chat. Both read the same views, so they can't disagree.

-- Every event in readable form.
create or replace view fleet.v_events with (security_invoker = true) as
select e.event_id,
       e.event_time,
       e.event_date,
       trim(to_char(e.event_date, 'Day'))            as day_name,
       e.ref_no,
       m.machine_type,
       hb.name                                       as home_branch,
       eb.name                                       as event_branch,
       et.code                                       as event_type,
       et.label                                      as event_label,
       et.counts_as_event,
       et.is_safety_event,
       coalesce(d.display_name, 'No driver logged on') as driver_name,
       e.driver_id,
       e.run_hours_seconds,
       e.is_late_arrival,
       e.branch_mismatch,
       sf.file_name                                  as source_file
from fleet.events e
join fleet.machines m     on m.ref_no = e.ref_no
join fleet.branches hb    on hb.branch_id = m.home_branch_id
join fleet.branches eb    on eb.branch_id = e.event_branch_id
join fleet.event_types et on et.code = e.event_type
join fleet.source_files sf on sf.file_id = e.file_id
left join fleet.drivers d on d.driver_id = e.driver_id;

-- One row per gap between consecutive readings of the RunHours counter.
-- Run time for the gap = the increase, capped at the clock time that passed.
-- A decrease is a counter reset: the gap adds nothing.
create or replace view fleet.v_run_intervals with (security_invoker = true) as
with ordered as (
  select e.*,
         lag(e.run_hours_seconds) over w as prev_counter,
         lag(e.event_time)        over w as prev_time
  from fleet.events e
  window w as (partition by e.ref_no, e.event_date order by e.event_time, e.run_hours_seconds, e.event_id)
)
select ref_no,
       event_date,
       event_time,
       driver_id,
       event_branch_id,
       run_hours_seconds - prev_counter                         as counter_increase,
       extract(epoch from event_time - prev_time)::bigint       as clock_seconds,
       (run_hours_seconds < prev_counter)                       as is_counter_reset,
       (run_hours_seconds - prev_counter > extract(epoch from event_time - prev_time)) as is_capped,
       case when run_hours_seconds < prev_counter then 0
            else least(run_hours_seconds - prev_counter, extract(epoch from event_time - prev_time)::bigint)
       end                                                      as run_seconds
from ordered
where prev_counter is not null;

-- Run hours per machine per day.
create or replace view fleet.v_machine_daily_hours with (security_invoker = true) as
select i.event_date,
       trim(to_char(i.event_date, 'Day'))                  as day_name,
       i.ref_no,
       m.machine_type,
       hb.name                                             as home_branch,
       (select b.name from fleet.branches b
         where b.branch_id = mode() within group (order by i.event_branch_id)) as operating_branch,
       sum(i.run_seconds)                                  as run_seconds,
       round(sum(i.run_seconds) / 3600.0, 2)               as run_hours,
       count(*) filter (where i.is_counter_reset)          as counter_resets,
       count(*) filter (where i.is_capped)                 as capped_intervals
from fleet.v_run_intervals i
join fleet.machines m  on m.ref_no = i.ref_no
join fleet.branches hb on hb.branch_id = m.home_branch_id
group by i.event_date, i.ref_no, m.machine_type, hb.name;

-- Run hours per driver per day (time is credited to whoever was logged on when it accrued).
create or replace view fleet.v_driver_daily_hours with (security_invoker = true) as
select i.event_date,
       trim(to_char(i.event_date, 'Day'))                  as day_name,
       coalesce(d.display_name, 'No driver logged on')     as driver_name,
       i.driver_id,
       round(sum(i.run_seconds) / 3600.0, 2)               as run_hours
from fleet.v_run_intervals i
left join fleet.drivers d on d.driver_id = i.driver_id
group by i.event_date, i.driver_id, d.display_name;

-- Safety and operational event counts per driver, machine and day (heartbeats excluded).
create or replace view fleet.v_event_counts with (security_invoker = true) as
select event_date, day_name, event_branch, ref_no, machine_type, driver_name, driver_id,
       event_type, event_label, is_safety_event,
       count(*) as event_count
from fleet.v_events
where counts_as_event
group by event_date, day_name, event_branch, ref_no, machine_type, driver_name, driver_id,
         event_type, event_label, is_safety_event;

-- Days that have data, so the chat can map "Tuesday" to a real date.
create or replace view fleet.v_available_days with (security_invoker = true) as
select event_date, trim(to_char(event_date, 'Day')) as day_name, count(*) as events
from fleet.events
group by event_date;

-- Latest run per file and rejected rows by reason, for the dashboard's data-quality panel.
create or replace view fleet.v_latest_runs with (security_invoker = true) as
select distinct on (file_name) *
from fleet.ingestion_runs
order by file_name, started_at desc;

create or replace view fleet.v_rejections_by_reason with (security_invoker = true) as
select sf.file_name, r.reason, count(*) as rows_rejected
from fleet.rejected_rows r
join fleet.source_files sf on sf.file_id = r.file_id
group by sf.file_name, r.reason;
