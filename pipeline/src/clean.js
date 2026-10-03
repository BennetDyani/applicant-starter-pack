/**
 * Ridgeback Logistics: telemetry cleaning rules (Task 1).
 *
 * One pure function, cleanFile(), turns one raw daily CSV into
 *   - rows:      clean, typed events ready to load
 *   - rejected:  every unusable line with the reason it was rejected
 *   - summary:   counts for the run log
 *
 * It has no dependencies and does no I/O, so the same code runs in:
 *   - the n8n Code node (Task 2), pasted as-is, and
 *   - Node.js tests and scripts (pipeline/tests, pipeline/scripts).
 */

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** Canonical event types. `counts_as_event` is false for the 30-minute heartbeat. */
const EVENT_TYPES = {
  'power up': { code: 'POWER_UP', counts_as_event: true, is_safety: false },
  'driver change': { code: 'DRIVER_CHANGE', counts_as_event: true, is_safety: false },
  'unit (time/gps) update level': { code: 'HEARTBEAT', counts_as_event: false, is_safety: false },
  impact: { code: 'IMPACT', counts_as_event: true, is_safety: true },
  'harsh braking': { code: 'HARSH_BRAKING', counts_as_event: true, is_safety: true },
  'harsh acceleration': { code: 'HARSH_ACCELERATION', counts_as_event: true, is_safety: true },
  speeding: { code: 'SPEEDING', counts_as_event: true, is_safety: true },
  'excess idle': { code: 'EXCESS_IDLE', counts_as_event: true, is_safety: true },
};

/** Header aliases. Columns are matched by name, never by position. */
const HEADER_ALIASES = {
  dateandtime: 'event_time',
  refno: 'ref_no',
  branchname: 'branch',
  txflagstrings: 'event_type',
  runhours: 'run_hours',
  drivername: 'driver_first_name',
  driversurname: 'driver_surname',
};
const REQUIRED_COLUMNS = Object.values(HEADER_ALIASES);

const REJECT = {
  WRONG_COLUMN_COUNT: 'wrong_column_count',
  REPEATED_HEADER: 'repeated_header_row',
  MISSING_VALUE: 'missing_required_value',
  INVALID_TIMESTAMP: 'invalid_timestamp',
  TIMESTAMP_AFTER_DELIVERY: 'timestamp_after_file_delivery',
  UNKNOWN_MACHINE: 'machine_not_in_machine_list',
  UNKNOWN_EVENT_TYPE: 'unknown_event_type',
  INVALID_RUN_HOURS: 'invalid_run_hours',
  DUPLICATE_IN_FILE: 'duplicate_row_in_file',
};

// ---------------------------------------------------------------------------
// Small normalisers
// ---------------------------------------------------------------------------

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const headerKey = (s) => collapse(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** "ridgeback  HARBOUR " -> "Harbour". The machine list uses names without the prefix. */
function normaliseBranch(raw) {
  const s = collapse(raw).replace(/^ridgeback\s*/i, '');
  return s ? titleCase(s) : null;
}

const normaliseRef = (raw) => collapse(raw).toUpperCase();

function titleCase(s) {
  return collapse(s)
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Returns null when no driver is logged on (both name parts blank). */
function normaliseDriver(first, surname) {
  const f = collapse(first);
  const s = collapse(surname);
  if (!f && !s) return null;
  const first_name = titleCase(f);
  const last_name = titleCase(s);
  return {
    first_name,
    surname: last_name,
    driver_key: `${first_name} ${last_name}`.trim().toLowerCase(),
  };
}

/**
 * Accepts the two formats seen in the data and returns "YYYY-MM-DD HH:MM:SS" (local SAST):
 *   2026-09-07T06:02:30   (ISO 8601, the documented format)
 *   10/09/2026 14:19:53   (day/month/year, seen in one file; day-first is assumed)
 */
function parseTimestamp(raw) {
  const s = collapse(raw);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/);
  let y, mo, d, h, mi, se;
  if (m) [, y, mo, d, h, mi, se] = m;
  else {
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})[T ](\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    [, d, mo, y, h, mi, se] = m;
  }
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  const valid =
    dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d &&
    +h < 24 && +mi < 60 && +se < 60;
  return valid ? `${y}-${mo}-${d} ${h}:${mi}:${se}` : null;
}

/** "2026-09-08_DailyTelemetryData.csv" -> { delivery_date: "2026-09-08", data_date: "2026-09-07" } */
function datesFromFileName(fileName) {
  const m = String(fileName).match(/(\d{4})-(\d{2})-(\d{2})_DailyTelemetryData\.csv$/i);
  if (!m) return { delivery_date: null, data_date: null };
  const delivery = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const data = new Date(delivery.getTime() - 86400000);
  return {
    delivery_date: delivery.toISOString().slice(0, 10),
    data_date: data.toISOString().slice(0, 10),
  };
}

/** Minimal RFC 4180 parser: quotes, escaped quotes, CRLF, BOM. Keeps raw line text and number. */
function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const records = [];
  let field = '', fields = [], inQuotes = false, line = 1, startLine = 1, raw = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; raw += '""'; i++; continue; }
      if (c === '"') { inQuotes = false; raw += c; continue; }
      if (c === '\n') line++;
      field += c; raw += c; continue;
    }
    if (c === '"') { inQuotes = true; raw += c; continue; }
    if (c === ',') { fields.push(field); field = ''; raw += c; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      fields.push(field);
      records.push({ line: startLine, fields, raw });
      field = ''; fields = []; raw = ''; line++; startLine = line; continue;
    }
    field += c; raw += c;
  }
  if (field !== '' || fields.length) { fields.push(field); records.push({ line: startLine, fields, raw }); }
  return records.filter((r) => r.raw.trim() !== '');
}

/** Machine list -> Map(ref_no -> { ref_no, branch, machine_type }). Trims stray spaces. */
function buildMachineIndex(machineListCsv) {
  const recs = parseCsv(machineListCsv);
  const header = recs[0].fields.map(headerKey);
  const iRef = header.indexOf('refno'), iBranch = header.indexOf('branchname'), iType = header.indexOf('machinetype');
  const index = new Map();
  for (const r of recs.slice(1)) {
    const ref = normaliseRef(r.fields[iRef]);
    if (!ref) continue;
    index.set(ref, {
      ref_no: ref,
      branch: normaliseBranch(r.fields[iBranch]),
      machine_type: collapse(r.fields[iType]),
    });
  }
  return index;
}

// ---------------------------------------------------------------------------
// The cleaning rules
// ---------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {string} p.fileName   e.g. "2026-09-08_DailyTelemetryData.csv"
 * @param {string} p.text       raw CSV content
 * @param {Map}    p.machines   from buildMachineIndex()
 * @returns {{file:object, rows:object[], rejected:object[], summary:object}}
 * @throws  if the file cannot be read at all (no recognisable header). The pipeline
 *          logs that file as failed and carries on with the next one.
 */
function cleanFile({ fileName, text, machines }) {
  const { delivery_date, data_date } = datesFromFileName(fileName);
  const records = parseCsv(text);
  if (!records.length) throw new Error('File is empty');

  // 1. Map columns by header name (one file reorders and renames them).
  const headerRec = records[0];
  const cols = headerRec.fields.map((h) => HEADER_ALIASES[headerKey(h)]);
  const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
  if (missing.length) throw new Error(`Missing required column(s): ${missing.join(', ')}`);
  const at = Object.fromEntries(cols.map((c, i) => [c, i]).filter(([c]) => c));
  const headerSignature = headerRec.fields.map(headerKey).join('|');

  const rows = [];
  const rejected = [];
  const seen = new Set();
  let lateRows = 0;
  let branchMismatches = 0;
  const reject = (rec, reason, detail) =>
    rejected.push({ line_no: rec.line, raw_line: rec.raw, reason, detail: detail ?? null });

  for (const rec of records.slice(1)) {
    const f = rec.fields;

    // 2. Structural checks.
    if (f.map(headerKey).join('|') === headerSignature) { reject(rec, REJECT.REPEATED_HEADER); continue; }
    if (f.length !== headerRec.fields.length) {
      reject(rec, REJECT.WRONG_COLUMN_COUNT, `expected ${headerRec.fields.length}, got ${f.length}`);
      continue;
    }

    const get = (col) => f[at[col]];
    const refNo = normaliseRef(get('ref_no'));
    const typeRaw = collapse(get('event_type'));
    const timeRaw = collapse(get('event_time'));
    const rhRaw = collapse(get('run_hours'));
    if (!refNo || !typeRaw || !timeRaw || !rhRaw) { reject(rec, REJECT.MISSING_VALUE); continue; }

    // 3. Timestamp: two formats accepted; never later than the delivery date.
    const eventTime = parseTimestamp(timeRaw);
    if (!eventTime) { reject(rec, REJECT.INVALID_TIMESTAMP, timeRaw); continue; }
    const eventDate = eventTime.slice(0, 10);
    if (delivery_date && eventDate >= delivery_date) {
      reject(rec, REJECT.TIMESTAMP_AFTER_DELIVERY, eventTime);
      continue;
    }

    // 4. Machine must exist in the machine list (it supplies type and home branch).
    const machine = machines.get(refNo);
    if (!machine) { reject(rec, REJECT.UNKNOWN_MACHINE, refNo); continue; }

    // 5. Event type must be a known type.
    const type = EVENT_TYPES[typeRaw.toLowerCase()];
    if (!type) { reject(rec, REJECT.UNKNOWN_EVENT_TYPE, typeRaw); continue; }

    // 6. RunHours: a whole, non-negative number of seconds.
    if (!/^\d+$/.test(rhRaw)) { reject(rec, REJECT.INVALID_RUN_HOURS, rhRaw); continue; }
    const runHours = Number(rhRaw);

    // 7. Exact duplicates inside the file. Duplicates across files are stopped by the
    //    database's unique key, which is what makes reloading a file safe.
    const key = `${refNo}|${eventTime}|${type.code}|${runHours}`;
    if (seen.has(key)) { reject(rec, REJECT.DUPLICATE_IN_FILE); continue; }
    seen.add(key);

    // 8. Keep the row. Flags are kept, not rejected: the event is still valid.
    const reportedBranch = normaliseBranch(get('branch')) ?? machine.branch;
    const isLate = data_date ? eventDate < data_date : false;
    const branchMismatch = reportedBranch !== machine.branch;
    if (isLate) lateRows++;
    if (branchMismatch) branchMismatches++;

    rows.push({
      ref_no: refNo,
      event_time: eventTime,
      event_type: type.code,
      run_hours_seconds: runHours,
      reported_branch: reportedBranch,
      driver: normaliseDriver(get('driver_first_name'), get('driver_surname')),
      source_line: rec.line,
      is_late_arrival: isLate,
      branch_mismatch: branchMismatch,
    });
  }

  const reasons = {};
  for (const r of rejected) reasons[r.reason] = (reasons[r.reason] || 0) + 1;

  return {
    file: { file_name: fileName, delivery_date, data_date },
    rows,
    rejected,
    summary: {
      rows_read: records.length - 1,
      rows_clean: rows.length,
      rows_rejected: rejected.length,
      rejected_by_reason: reasons,
      late_arrival_rows: lateRows,
      branch_mismatch_rows: branchMismatches,
    },
  };
}

module.exports = {
  EVENT_TYPES,
  REJECT,
  cleanFile,
  buildMachineIndex,
  parseCsv,
  parseTimestamp,
  normaliseBranch,
  normaliseDriver,
  normaliseRef,
  datesFromFileName,
};
