// Runs the cleaning rules over every file in data/incoming and prints a report.
// Usage: node pipeline/scripts/clean-all.js            (from the repo root)
const fs = require('fs');
const path = require('path');
const { cleanFile, buildMachineIndex } = require('../src/clean');
const { dailyRunSeconds } = require('../src/runHours');

const root = path.resolve(__dirname, '..', '..');
const machines = buildMachineIndex(fs.readFileSync(path.join(root, 'data', 'machine_list.csv'), 'utf8'));
const dir = path.join(root, 'data', 'incoming');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();

const all = new Map();
for (const fileName of files) {
  try {
    const res = cleanFile({ fileName, text: fs.readFileSync(path.join(dir, fileName), 'utf8'), machines });
    console.log(fileName, JSON.stringify(res.summary));
    for (const r of res.rows) all.set(`${r.ref_no}|${r.event_time}|${r.event_type}|${r.run_hours_seconds}`, r);
  } catch (e) {
    console.log(fileName, 'FAILED:', e.message);
  }
}
const rows = [...all.values()];
console.log('\nUnique clean events across all files:', rows.length);

const counts = {};
for (const r of rows) counts[r.event_type] = (counts[r.event_type] || 0) + 1;
console.log('By type:', counts);

const hours = dailyRunSeconds(rows);
const flagged = hours.filter((h) => h.counter_resets || h.capped_intervals);
console.log('\nMachine-days:', hours.length, '| with resets or capped gaps:', flagged.length);
for (const h of flagged) console.log('  ', h);
