-- Ridgeback Logistics: pre-computed data-quality summary for the chat agent (Task 3).
-- Testing showed the model could mis-attribute counts when it added up the per-file rows itself
-- (it reported "duplicates 1 to 21 per day" when 21 was the unknown-machine count).
-- This function does all the counting in SQL, so the model only reads totals out.

create or replace function fleet.chat_data_quality_summary()
returns table (section text, item text, value bigint, detail text)
language sql stable
set search_path = ''
as $$
  with files as (
    select r.file_name, sf.data_date, r.status, r.rows_read,
           r.rows_loaded + coalesce(r.rows_already_loaded, 0) as rows_loaded, r.rows_rejected
    from fleet.v_latest_runs r
    left join fleet.source_files sf on sf.file_name = r.file_name
  ),
  span as (
    select min(data_date) as d0, max(data_date) as d1 from files where data_date is not null
  ),
  days as (
    select g::date as d from span, generate_series(span.d0, span.d1, interval '1 day') g
  ),
  missing as (
    select d from days
    where d not in (select data_date from files where status = 'success' and data_date is not null)
  ),
  reasons as (
    select x.reason,
           sum(x.rows_rejected)::bigint as total,
           string_agg(to_char(sf.data_date, 'Dy FMDD Mon') || ': ' || x.rows_rejected, ', '
                      order by sf.data_date) as per_day
    from fleet.v_rejections_by_reason x
    join fleet.source_files sf on sf.file_name = x.file_name
    group by x.reason
  )
  select 'coverage', 'days with data',
         (select count(*) from days) - (select count(*) from missing),
         (select to_char(d0, 'Dy FMDD Mon YYYY') || ' to ' || to_char(d1, 'Dy FMDD Mon YYYY') from span)
  union all
  select 'coverage', 'missing days', (select count(*) from missing),
         coalesce((select string_agg(to_char(d, 'Dy FMDD Mon'), ', ' order by d) from missing), 'none')
  union all
  select 'coverage', 'failed files', (select count(*) from files where status = 'failed'),
         coalesce((select string_agg(file_name, ', ' order by file_name) from files where status = 'failed'), 'none')
  union all
  select 'totals', 'rows read', (select sum(rows_read) from files where status = 'success'), null
  union all
  select 'totals', 'rows loaded', (select sum(rows_loaded) from files where status = 'success'), null
  union all
  select 'totals', 'rows rejected', (select sum(rows_rejected) from files where status = 'success'), null
  union all
  (select 'rejections', reason, total, 'per day: ' || per_day from reasons order by total desc)
  union all
  select 'freshness', 'last load', null,
         (select to_char(max(finished_at) at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') || ' SAST'
          from fleet.ingestion_runs)
$$;

revoke execute on function fleet.chat_data_quality_summary() from public;
grant execute on function fleet.chat_data_quality_summary() to fleet_reader;
