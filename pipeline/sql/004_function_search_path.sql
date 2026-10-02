-- Pin search_path on the load functions (Supabase security advisor 0011).
-- All objects inside them are schema-qualified, so an empty search_path is safe.
alter function fleet.upsert_machines(jsonb) set search_path = '';
alter function fleet.load_clean_file(jsonb) set search_path = '';
alter function fleet.log_failed_run(text, text, timestamptz, text) set search_path = '';
