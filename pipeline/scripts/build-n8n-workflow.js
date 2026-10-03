// Generates the n8n Workflow SDK code for the ingestion pipeline.
// The cleaning rules are copied from src/clean.js at build time, so the n8n Code nodes
// always run the same code as the unit tests. Usage: node pipeline/scripts/build-n8n-workflow.js > out.ts
const fs = require('fs');
const path = require('path');

const lib = fs.readFileSync(path.join(__dirname, '..', 'src', 'clean.js'), 'utf8')
  .replace(/module\.exports\s*=\s*\{[\s\S]*?\};\s*$/, '')
  .replace(/\/\*\*[\s\S]*?\*\//g, '')          // drop JSDoc blocks (the source file keeps them)
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')  // drop comment-only lines
  .replace(/\n{3,}/g, '\n\n')
  .trim();
const banner = '// Cleaning rules: generated from pipeline/src/clean.js. Edit that file, not this node.\n';

const pickFilesCode = `// Decide which files to load: new files, files whose content changed, and files that
// failed before (failed files are never registered in fleet.source_files, so they retry).
const ctx = $('Set run context').first().json;
let loaded = $input.first().json.loaded || [];
if (typeof loaded === 'string') loaded = JSON.parse(loaded);
const loadedChecksums = new Map(loaded.map((f) => [f.file_name, f.checksum]));

return $('Keep daily telemetry files').all()
  .map((i) => i.json)
  .filter((f) => ctx.reprocess_all === true || loadedChecksums.get(f.name) !== f.sha)
  .sort((a, b) => a.name.localeCompare(b.name))   // load in date order
  .map((f) => ({ json: { file_name: f.name, sha: f.sha, download_url: f.download_url, size: f.size } }));
`;

const cleanCode = banner + lib + `

// ---- Node logic ----
const file = $('Loop over files').first().json;
const ctx = $('Set run context').first().json;
const machines = buildMachineIndex($('Get machine list').first().json.data);
const text = $input.first().json.data;
if (typeof text !== 'string' || !text.trim()) throw new Error('Downloaded file is empty');

const result = cleanFile({ fileName: file.file_name, text, machines });
result.file.checksum = file.sha;
result.machines = [...machines.values()];   // synced in the same transaction as the file
result.run = { started_at: ctx.run_started_at, triggered_by: ctx.triggered_by };

return [{ json: { file_name: file.file_name, summary: result.summary, payload: JSON.stringify(result) } }];
`;

const q = (s) => JSON.stringify(s);

const sdk = `
const dailySchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Daily 04:00 SAST',
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 4, triggerAtMinute: 0 }] } },
    position: [0, 200]
  },
  output: [{}]
});

const manualRun = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Run manually', position: [0, 400] },
  output: [{}]
});

const runContext = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Set run context',
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'ctx-started', name: 'run_started_at', value: expr('{{ $now.toISO() }}'), type: 'string' },
          { id: 'ctx-trigger', name: 'triggered_by', value: expr('{{ $execution.mode === "manual" ? "manual" : "schedule" }}'), type: 'string' },
          { id: 'ctx-reprocess', name: 'reprocess_all', value: false, type: 'boolean' },
          { id: 'ctx-repo', name: 'repo', value: 'BennetDyani/applicant-starter-pack', type: 'string' },
          { id: 'ctx-branch', name: 'branch', value: 'main', type: 'string' }
        ]
      }
    },
    position: [240, 300]
  },
  output: [{ run_started_at: '2026-10-03T04:00:00.000+02:00', triggered_by: 'schedule', reprocess_all: false, repo: 'BennetDyani/applicant-starter-pack', branch: 'main' }]
});

const getMachineList = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Get machine list',
    parameters: {
      method: 'GET',
      url: expr('https://raw.githubusercontent.com/{{ $json.repo }}/{{ $json.branch }}/data/machine_list.csv'),
      options: { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } }
    },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    position: [480, 300]
  },
  output: [{ data: 'RefNo.,BranchName,MachineType' }]
});

const listFiles = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'List incoming files',
    parameters: {
      method: 'GET',
      url: expr('https://api.github.com/repos/{{ $("Set run context").first().json.repo }}/contents/data/incoming?ref={{ $("Set run context").first().json.branch }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] },
      options: {}
    },
    executeOnce: true,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    position: [720, 300]
  },
  output: [{ name: '2026-09-08_DailyTelemetryData.csv', sha: 'abc', size: 93123, download_url: 'https://raw.githubusercontent.com/x/y/main/data/incoming/2026-09-08_DailyTelemetryData.csv' }]
});

const keepTelemetry = node({
  type: 'n8n-nodes-base.filter',
  version: 2.2,
  config: {
    name: 'Keep daily telemetry files',
    parameters: {
      conditions: {
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $json.name }}'), operator: { type: 'string', operation: 'regex' }, rightValue: '^\\\\d{4}-\\\\d{2}-\\\\d{2}_DailyTelemetryData\\\\.csv$' }],
        combinator: 'and'
      }
    },
    position: [960, 300]
  },
  output: [{ name: '2026-09-08_DailyTelemetryData.csv', sha: 'abc', size: 93123, download_url: 'https://raw.githubusercontent.com/x/y/main/data/incoming/2026-09-08_DailyTelemetryData.csv' }]
});

const getLoaded = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.7,
  config: {
    name: 'Get already loaded files',
    parameters: {
      operation: 'executeQuery',
      query: "select coalesce(json_agg(json_build_object('file_name', file_name, 'checksum', checksum)), '[]'::json) as loaded from fleet.source_files;",
      options: {}
    },
    credentials: { postgres: newCredential('Ridgeback Supabase (fleet_pipeline)') },
    executeOnce: true,
    position: [1200, 300]
  },
  output: [{ loaded: [] }]
});

const pickFiles = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Pick files to load',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: ${q(pickFilesCode)} },
    position: [1440, 300]
  },
  output: [{ file_name: '2026-09-08_DailyTelemetryData.csv', sha: 'abc', download_url: 'https://raw.githubusercontent.com/x/y/main/data/incoming/2026-09-08_DailyTelemetryData.csv', size: 93123 }]
});

const loopFiles = splitInBatches({
  version: 3,
  config: { name: 'Loop over files', parameters: { batchSize: 1, options: {} }, position: [1680, 300] }
});

const downloadFile = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Download file',
    parameters: {
      method: 'GET',
      url: expr('{{ $json.download_url }}'),
      options: { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } }
    },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'continueErrorOutput',
    position: [1920, 460]
  },
  output: [{ data: 'DateAndTime,RefNo.,BranchName,TxFlagStrings,RunHours,DriverName,DriverSurname' }]
});

const cleanFileNode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Clean file',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: ${q(cleanCode)} },
    onError: 'continueErrorOutput',
    position: [2160, 460]
  },
  output: [{ file_name: '2026-09-08_DailyTelemetryData.csv', summary: { rows_read: 950 }, payload: '{}' }]
});

const loadFile = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.7,
  config: {
    name: 'Load into database',
    parameters: {
      operation: 'executeQuery',
      query: 'select fleet.load_clean_file($1::jsonb) as result;',
      options: { queryReplacement: expr('{{ [ $json.payload ] }}') }
    },
    credentials: { postgres: newCredential('Ridgeback Supabase (fleet_pipeline)') },
    onError: 'continueErrorOutput',
    position: [2400, 460]
  },
  output: [{ result: { status: 'success', rows_loaded: 936, rows_rejected: 14 } }]
});

const logFailed = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.7,
  config: {
    name: 'Log failed run',
    parameters: {
      operation: 'executeQuery',
      query: 'select fleet.log_failed_run($1, $2, $3::timestamptz, $4) as run_id;',
      options: {
        queryReplacement: expr('{{ [ $("Loop over files").first().json.file_name, String(typeof $json.error === "string" ? $json.error : ($json.error?.message ?? $json.message ?? JSON.stringify($json))).slice(0, 2000), $("Set run context").first().json.run_started_at, $("Set run context").first().json.triggered_by ] }}')
      }
    },
    credentials: { postgres: newCredential('Ridgeback Supabase (fleet_pipeline)') },
    position: [2400, 700]
  },
  output: [{ run_id: 1 }]
});

const runSummary = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.7,
  config: {
    name: 'Summarise this run',
    parameters: {
      operation: 'executeQuery',
      query: 'select file_name, status, rows_read, rows_loaded, rows_already_loaded, rows_rejected, error_message from fleet.ingestion_runs where started_at = $1::timestamptz order by file_name;',
      options: { queryReplacement: expr('{{ [ $("Set run context").first().json.run_started_at ] }}') }
    },
    credentials: { postgres: newCredential('Ridgeback Supabase (fleet_pipeline)') },
    executeOnce: true,
    position: [1920, 140]
  },
  output: [{ file_name: '2026-09-08_DailyTelemetryData.csv', status: 'success', rows_loaded: 936, rows_rejected: 14 }]
});

const notes = sticky('## Ridgeback Logistics: daily telemetry ingestion\\n\\nRuns every day at **04:00 SAST** (or manually). For each new or changed file in \`data/incoming/\` (stand-in for the client SFTP folder):\\n1. Download, then clean with the rules in \`pipeline/src/clean.js\`\\n2. Load in **one database transaction** via \`fleet.load_clean_file()\`\\n3. Rejected rows are stored with a reason; every run is logged in \`fleet.ingestion_runs\`\\n\\n**Safe to rerun:** the events table has a natural unique key, so reloading a file adds nothing.\\n**One bad file never stops the rest:** each step routes errors to *Log failed run* and the loop moves on. Failed files retry on the next run.\\n\\nSet \`reprocess_all\` to true in *Set run context* to reload every file.', [runContext, getMachineList, listFiles], { color: 4, width: 520, height: 420 });

export default workflow('ridgeback-ingestion', 'Ridgeback Logistics - Daily telemetry ingestion')
  .add(manualRun)
  .to(runContext)
  .to(getMachineList)
  .to(listFiles)
  .to(keepTelemetry)
  .to(getLoaded)
  .to(pickFiles)
  .to(loopFiles
    .onDone(runSummary)
    .onEachBatch(downloadFile.to(cleanFileNode.to(loadFile.to(nextBatch(loopFiles))))))
  .add(downloadFile.onError(logFailed))
  .add(cleanFileNode.onError(logFailed))
  .add(loadFile.onError(logFailed))
  .add(logFailed)
  .to(nextBatch(loopFiles))
  .add(dailySchedule)
  .to(runContext)
  .add(notes)
  .group('Prepare run', [getMachineList, listFiles, keepTelemetry, getLoaded, pickFiles], { description: 'Fetch the machine list, list files in the incoming folder, and pick new or changed files to load in date order' })
  .group('Load one file', [downloadFile, cleanFileNode, loadFile], { description: 'Download, clean and load one file in a single transaction; any error goes to Log failed run' });
`;
process.stdout.write(sdk);
