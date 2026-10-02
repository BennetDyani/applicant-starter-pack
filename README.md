# Ridgeback Logistics: fleet data assessment

Create a GitHub repo from the contents of this folder and do all your work there. Fill in the links below before you submit. The full brief came with the email you received.

| Item | Link |
| --- | --- |
| Live app | |
| Walkthrough video | |
| Solution design diagram | `docs/...` |

## Checklist

- [x] **Task 1.** Cleaning code and a data model
- [ ] **Task 2.** Ingestion pipeline in `pipeline/`, including exported n8n workflow JSON if you used n8n
- [ ] **Task 3.** Hosted dashboard and chat in `app/`, and `docs/chat_results.md` with 5 test questions and the answers
- [ ] **Task 4.** Solution design diagram in `docs/`, as the source file and a PNG or PDF
- [ ] No API keys in the repo or in front-end code
- [ ] The sections below are filled in

## Repo layout

```
data/
  incoming/          7 daily telemetry files (don't edit these)
  machine_list.csv   one row per machine
docs/
  fields_glossary.md what each column means
  chat_results.md    your chat test results (Task 3)
pipeline/            your ingestion pipeline (Task 2)
app/                 your dashboard and chat (Task 3)
```

## How to run the pipeline

_Commands or steps to load the files in `data/incoming/` into your database._

## Model used and why

_Which model or models you used through OpenRouter, and why._

## Data model

Postgres (Supabase), schema `fleet`. Full ERD, cleaning rules and run-hours method: [`docs/data_model.md`](docs/data_model.md). DDL: [`pipeline/sql/`](pipeline/sql).

- **Reference:** `branches`, `machines`, `drivers`, `event_types`
- **Facts:** `events`, unique on `(ref_no, event_time, event_type, run_hours_seconds)` so reloads never duplicate
- **Pipeline bookkeeping:** `source_files`, `rejected_rows`, `ingestion_runs`
- **Views** used by both the dashboard and the chat: `v_machine_daily_hours`, `v_driver_daily_hours`, `v_event_counts`, `v_events`, `v_available_days`, `v_latest_runs`, `v_rejections_by_reason`

Cleaning code: [`pipeline/src/clean.js`](pipeline/src/clean.js). Tests: `npm test`. Report over all seven files: `npm run clean:report`.

## Assumptions

- **Run hours** for a day are the sum of increases in the `RunHours` counter between consecutive readings, each capped at the clock time between them. A decrease is a counter reset and adds nothing. See [`docs/data_model.md`](docs/data_model.md#run-hours).
- **Day of an event** comes from its timestamp, not the file name. A file named `2026-09-09_...` holds Tuesday 8 September.
- **Timestamps** are local SAST. `10/09/2026` style dates are day/month/year, which matches the file's delivery date.
- **Heartbeat rows** (`Unit (Time/GPS) Update Level`) are kept for their `RunHours` readings but never counted as events.
- **Safety events** are Impact, Harsh Braking, Harsh Acceleration, Speeding and Excess Idle.
- **Events with no driver** are kept and shown as "No driver logged on". A driver isn't guessed from earlier rows.
- **Branch:** events are reported at the branch they happened at. When that differs from the machine's home branch in the machine list, the event is kept and flagged (`R88897`, Northgate, reports from Riverside on 10–11 Sep).
- **Unknown machines** (`FBA37633406217`) are rejected, because they can't be matched to a type or home branch. Adding them to the machine list and reloading the file would bring them in.
- **Late-arriving events** (older than the file's data date) are kept and flagged. Ones already loaded from the previous file are skipped by the unique key.
- **Exact duplicate rows** within a file are rejected and recorded with the reason `duplicate_row_in_file`.
- **Driver names** that differ only in case are the same driver.

## AI tools used

_Which AI tools you used and what you used them for._

## What I would do next

_What you would add or change with more time._
