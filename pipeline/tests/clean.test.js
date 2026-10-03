// Run with: node --test pipeline/tests
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/clean');
const { dailyRunSeconds } = require('../src/runHours');

const machines = c.buildMachineIndex('RefNo.,BranchName,MachineType\nFBA1,Harbour,Forklift\nP2 ,Airport,PPT\n');
const HDR = 'DateAndTime,RefNo.,BranchName,TxFlagStrings,RunHours,DriverName,DriverSurname';
const run = (body, fileName = '2026-09-08_DailyTelemetryData.csv') =>
  c.cleanFile({ fileName, text: `${HDR}\r\n${body}`, machines });

test('parses both timestamp formats and rejects nonsense', () => {
  assert.equal(c.parseTimestamp('2026-09-07T06:02:30'), '2026-09-07 06:02:30');
  assert.equal(c.parseTimestamp('10/09/2026 14:19:53'), '2026-09-10 14:19:53');
  assert.equal(c.parseTimestamp('31/02/2026 10:00:00'), null);
  assert.equal(c.parseTimestamp('DateAndTime'), null);
});

test('normalises branches, refs and driver names', () => {
  assert.equal(c.normaliseBranch('  RIDGEBACK  HARBOUR '), 'Harbour');
  assert.equal(c.normaliseRef(' fba1 '), 'FBA1');
  assert.deepEqual(c.normaliseDriver('ASHWIN', 'DANIELS'), { first_name: 'Ashwin', surname: 'Daniels', driver_key: 'ashwin daniels' });
  assert.equal(c.normaliseDriver(' ', ''), null);
});

test('maps columns by name when they are reordered and renamed', () => {
  const text = 'Branch Name,Ref No,DateAndTime,TxFlagStrings,RunHours,DriverName,DriverSurname\nRidgeback Harbour,FBA1,2026-09-07T06:00:00,Impact,100,A,B\n';
  const res = c.cleanFile({ fileName: '2026-09-08_DailyTelemetryData.csv', text, machines });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].event_type, 'IMPACT');
});

test('rejects bad rows with a reason and keeps good ones', () => {
  const res = run([
    '2026-09-07T06:00:00,FBA1,Ridgeback Harbour,Power Up,100,,',
    '2026-09-07T06:00:00,FBA1,Ridgeback Harbour,Power Up,100,,',       // duplicate
    'DateAndTime,RefNo.,BranchName,TxFlagStrings,RunHours,DriverName,DriverSurname', // repeated header
    '2026-09-07T07:00:00,UNKNOWN,Ridgeback Harbour,Impact,200,A,B',     // unknown machine
    '2026-09-07T08:00:00,FBA1,Ridgeback Harb',                          // truncated
    '2026-09-07T09:00:00,FBA1,Ridgeback Harbour,Teleport,300,A,B',      // unknown type
    '2026-09-08T09:00:00,FBA1,Ridgeback Harbour,Impact,300,A,B',        // after delivery
  ].join('\r\n'));
  assert.equal(res.rows.length, 1);
  assert.deepEqual(res.rejected.map((r) => r.reason), [
    'duplicate_row_in_file', 'repeated_header_row', 'machine_not_in_machine_list',
    'wrong_column_count', 'unknown_event_type', 'timestamp_after_file_delivery',
  ]);
});

test('flags late-arriving rows and branch mismatches without rejecting them', () => {
  const res = run('2026-09-06T23:00:00,P2,Ridgeback Riverside,Speeding,50,A,B', '2026-09-08_DailyTelemetryData.csv');
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].is_late_arrival, true);
  assert.equal(res.rows[0].branch_mismatch, true);
});

test('fails the whole file when a required column is missing', () => {
  assert.throws(() => c.cleanFile({ fileName: 'x.csv', text: 'Foo,Bar\n1,2\n', machines }), /Missing required column/);
});

test('run hours: sums increases, caps at clock time, ignores counter resets', () => {
  const r = (t, s) => ({ ref_no: 'FBA1', event_time: `2026-09-07 ${t}`, run_hours_seconds: s });
  const [day] = dailyRunSeconds([
    r('08:00:00', 1000), r('08:30:00', 2800),  // +1800 in 1800s
    r('09:00:00', 50),                          // reset: adds nothing
    r('09:30:00', 1850),                        // +1800
    r('09:40:00', 5000),                        // +3150 in 600s -> capped to 600
  ]);
  assert.equal(day.run_seconds, 4200);
  assert.equal(day.counter_resets, 1);
  assert.equal(day.capped_intervals, 1);
});
