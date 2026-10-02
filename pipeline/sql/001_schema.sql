-- Ridgeback Logistics fleet data model (Task 1)
-- Everything lives in its own schema, "fleet". Supabase only exposes "public" through its
-- auto-generated REST API, so nothing here is reachable with the public anon key.

create schema if not exists fleet;

-- Reference data -------------------------------------------------------------

create table if not exists fleet.branches (
  branch_id   smallint generated always as identity primary key,
  name        text not null unique                      -- "Harbour", without the "Ridgeback " prefix
);

create table if not exists fleet.machines (
  ref_no          text primary key,                     -- trimmed, upper case
  home_branch_id  smallint not null references fleet.branches,
  machine_type    text not null check (machine_type in ('Forklift', 'Reach Truck', 'PPT')),
  updated_at      timestamptz not null default now()
);

create table if not exists fleet.drivers (
  driver_id    integer generated always as identity primary key,
  driver_key   text not null unique,                    -- lower-case "first surname", merges case variants
  first_name   text not null,
  surname      text not null,
  display_name text generated always as (trim(first_name || ' ' || surname)) stored
);

create table if not exists fleet.event_types (
  code            text primary key,
  label           text not null,
  counts_as_event boolean not null,                     -- false for the 30-minute heartbeat
  is_safety_event boolean not null
);

insert into fleet.event_types (code, label, counts_as_event, is_safety_event) values
  ('POWER_UP',           'Power Up',                      true,  false),
  ('DRIVER_CHANGE',      'Driver Change',                 true,  false),
  ('HEARTBEAT',          'Unit (Time/GPS) Update Level',  false, false),
  ('IMPACT',             'Impact',                        true,  true),
  ('HARSH_BRAKING',      'Harsh Braking',                 true,  true),
  ('HARSH_ACCELERATION', 'Harsh Acceleration',            true,  true),
  ('SPEEDING',           'Speeding',                      true,  true),
  ('EXCESS_IDLE',        'Excess Idle',                   true,  true)
on conflict (code) do nothing;

-- Pipeline bookkeeping -------------------------------------------------------

create table if not exists fleet.source_files (
  file_id          integer generated always as identity primary key,
  file_name        text not null unique,
  delivery_date    date,                                -- date in the file name
  data_date        date,                                -- the day the events belong to (delivery - 1)
  checksum         text,                                -- SHA-256 of the content, to spot a changed re-delivery
  first_loaded_at  timestamptz not null default now(),
  last_loaded_at   timestamptz not null default now(),
  load_count       integer not null default 1
);

create table if not exists fleet.ingestion_runs (
  run_id               bigint generated always as identity primary key,
  file_name            text not null,
  file_id              integer references fleet.source_files,
  started_at           timestamptz not null,
  finished_at          timestamptz not null default now(),
  status               text not null check (status in ('success', 'failed')),
  rows_read            integer,
  rows_loaded          integer,                         -- new events inserted by this run
  rows_already_loaded  integer,                         -- clean rows that were already in the table (reruns, late duplicates)
  rows_rejected        integer,
  error_message        text,
  triggered_by         text not null default 'schedule' -- 'schedule' or 'manual'
);
create index if not exists ingestion_runs_file_idx on fleet.ingestion_runs (file_name, started_at desc);

-- Facts ----------------------------------------------------------------------

create table if not exists fleet.events (
  event_id           bigint generated always as identity primary key,
  ref_no             text not null references fleet.machines,
  event_time         timestamp not null,                -- local SAST, as delivered (South Africa has no DST)
  event_date         date generated always as (event_time::date) stored,
  event_type         text not null references fleet.event_types,
  run_hours_seconds  bigint not null check (run_hours_seconds >= 0),
  driver_id          integer references fleet.drivers,  -- null = no driver logged on
  event_branch_id    smallint not null references fleet.branches, -- where the event happened
  file_id            integer not null references fleet.source_files,
  source_line        integer not null,
  is_late_arrival    boolean not null default false,    -- event is older than the file's data date
  branch_mismatch    boolean not null default false,    -- event branch differs from the machine's home branch
  loaded_at          timestamptz not null default now(),
  -- The natural key: loading the same file twice, or an event repeated in a later file,
  -- can never create a second row.
  constraint events_natural_key unique (ref_no, event_time, event_type, run_hours_seconds)
);
create index if not exists events_machine_day_idx on fleet.events (ref_no, event_date, event_time);
create index if not exists events_date_idx on fleet.events (event_date);
create index if not exists events_driver_idx on fleet.events (driver_id);

create table if not exists fleet.rejected_rows (
  rejected_id  bigint generated always as identity primary key,
  file_id      integer not null references fleet.source_files,
  line_no      integer not null,
  raw_line     text not null,
  reason       text not null,
  detail       text,
  rejected_at  timestamptz not null default now(),
  constraint rejected_rows_file_line unique (file_id, line_no)
);
