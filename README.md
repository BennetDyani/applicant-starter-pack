# Ridgeback Logistics: fleet data assessment

Create a GitHub repo from the contents of this folder and do all your work there. Fill in the links below before you submit. The full brief came with the email you received.

| Item | Link |
| --- | --- |
| Live app | https://applicant-starter-pack-app.vercel.app |
| Walkthrough video | _to add_ |
| Solution design diagram | [`docs/solution_design.png`](docs/solution_design.png) (source: [`docs/solution_design.lucid.json`](docs/solution_design.lucid.json), notes: [`docs/solution_design.md`](docs/solution_design.md), [interactive view](https://lucid.app/lucidchart/612a57a0-f199-40b8-aa0a-26bdcaa198d0/edit?invitationId=inv_f529f2f7-befa-4392-bad9-a3d00bf07c2e)) |

## Checklist

- [x] **Task 1.** Cleaning code and a data model
- [x] **Task 2.** Ingestion pipeline in `pipeline/`, including exported n8n workflow JSON if you used n8n
- [x] **Task 3.** Hosted dashboard and chat in `app/`, and `docs/chat_results.md` with 5 test questions and the answers
- [x] **Task 4.** Solution design diagram in `docs/`, as the source file and a PNG or PDF
- [x] No API keys in the repo or in front-end code (OpenRouter key only in n8n credentials; webhook secret only in Vercel env vars)
- [x] The sections below are filled in

## Repo layout

```
data/
  incoming/          7 daily telemetry files (don't edit these)
  machine_list.csv   one row per machine
docs/
  fields_glossary.md     what each column means
  data_model.md          ERD (Lucid PNG + Mermaid), cleaning rules, run-hours method
  erd.png
  solution_design.md     Task 4 notes; .png and .lucid.json alongside
  chat_results.md        5 chat test questions, answers and checks (Task 3)
pipeline/                SQL migrations, clean.js + tests, all 3 n8n workflow exports (Tasks 2-3)
app/                     static dashboard + chat, Vercel functions, agent system prompt (Task 3)
scripts/dev-app.mjs      run the app locally: npm run dev:app
```

## How to run the pipeline

An n8n workflow (export in [`pipeline/n8n/`](pipeline/n8n)) runs every day at **04:00 SAST** and loads each new or changed file in `data/incoming/` into Postgres. Full details, guarantees and results: [`pipeline/README.md`](pipeline/README.md).

1. Apply [`pipeline/sql/`](pipeline/sql) `001`–`008` to Postgres and set passwords for the `fleet_pipeline` and `fleet_reader` roles.
2. In n8n, create a Postgres credential for `fleet_pipeline` (Supabase Session pooler, SSL required). The dashboard and chat use a separate, read-only `fleet_reader` credential.
3. Import the workflow JSON, select the credential on the four Postgres nodes, and **Execute workflow** (or activate it for the 04:00 schedule).
4. Check `fleet.ingestion_runs` for one row per file: rows read, loaded, already loaded, rejected, status.

Reloading is safe: running all seven files a second time inserts 0 rows. A file that fails is logged as `failed` and the rest still load; it is retried on the next run.

## How to run the app

Live: https://applicant-starter-pack-app.vercel.app. Setup, deployment and the security guards are described in [`app/README.md`](app/README.md).

- **Locally:** create `app/.env.local` with `N8N_DASHBOARD_URL`, `N8N_CHAT_URL` and `N8N_WEBHOOK_SECRET` (see `.env.example`), then run `npm run dev:app` and open http://localhost:3000.
- **Hosting:** Vercel, root directory `app`, the same three environment variables. Every push to `agent-bennet-dyani` redeploys.

## Model used and why

**Primary: `openai/gpt-4.1-mini`. Fallback: `google/gemini-2.5-flash`.** Both run at temperature 0, with a 600-token cap.

- **The job is tool routing, not reasoning.** Every number comes from six fixed SQL functions. The model only has to pick the right tool, fill in dates and filters, and write one to three sentences. GPT-4.1 mini is reliable at tool calling and follows instructions well, and it answered every test question correctly (see [`docs/chat_results.md`](docs/chat_results.md)).
- **Speed and cost.** It doesn't use a reasoning mode, so answers take about 2–6 s. At about $0.40 / $1.60 per million input/output tokens, a typical question (about 2.5k tokens across two tool calls) costs well under a cent.
- **Resilience.** The fallback is from a different provider, so an outage or rate limit at one provider doesn't take the chat down. n8n switches to it automatically. If both fail, the user gets a friendly retry message.
- **What I didn't pick.** Reasoning models were slower and cost more without improving answers that the tools already make correct. Very new models had no track record of reliable tool calling yet. A larger model wouldn't add accuracy here, because the SQL functions do the arithmetic.

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
- **File source:** for the assessment the pipeline reads files from this repo's `data/incoming/` through the GitHub API, standing in for the client's SFTP folder. A file counts as already loaded when its name and content hash match a previous successful load.
- **Database TLS:** n8n Cloud connects to Supabase over TLS with certificate verification relaxed (Supabase uses its own CA). In production the Supabase CA certificate would be installed so the certificate is verified too.

## AI tools used

- **Claude (Anthropic, in Cowork)** as a pair programmer and reviewer. It helped draft the cleaning code and tests, SQL migrations, n8n workflows (through the n8n MCP server), the dashboard and Vercel functions, the Lucid diagrams (through the Lucid connector), and these docs. I made the design decisions: least-privilege roles, fixed SQL tools instead of model-written SQL, the run-hours method, and the model choice. I reviewed every change.
- **Verification didn't rely on AI.** Every figure in the dashboard and in the chat results was checked against the raw CSVs and with direct SQL. The cleaning rules have unit tests (`npm test`).
- **OpenRouter models** (GPT-4.1 mini, Gemini 2.5 Flash) run inside the product, only in the chat agent.

## What I would do next

- **Freshness alert:** a 05:00 n8n check that emails or posts to Slack when no file has arrived. It is shown dashed in the solution design.
- **Weekly summary:** every Monday at 07:00, generate last week's numbers with the same SQL functions and email them to the ops team, with the LLM only writing the commentary.
- **Automated chat evals:** run the questions in `chat_results.md` (and more) on every prompt or model change, compare the answers with SQL ground truth, and fail the build on a regression.
- **Chat follows the dashboard filter:** pass the selected period to the agent, so "which machine ran most?" means the day the user is looking at.
- **Production hardening:** read from the client's SFTP folder instead of GitHub, verify the Supabase CA certificate, use a shared rate-limit store, add sign-in to the dashboard (the data names drivers), and send n8n and Vercel errors to an alerting channel.
- **Data quality:** an admin view to replay rejected rows after the machine list is fixed (for example `FBA37633406217`), and a per-driver detail page.
- **Hosting:** n8n Cloud must stay up for reviewers. In production I'd self-host n8n or use a plan with guaranteed uptime.
