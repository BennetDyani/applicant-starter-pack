/**
 * Daily run time from the cumulative RunHours counter.
 *
 * RunHours is an odometer (seconds since install), so time run on a day is how much
 * it went up that day. "Last minus first" breaks on real data, so we:
 *   1. sort a machine's readings by time,
 *   2. add up each increase between consecutive readings,
 *   3. cap each increase at the clock time that passed (a motor can't run 20 minutes in 15),
 *   4. treat a decrease as a counter reset: that gap adds nothing and the new value is the baseline.
 *
 * The SQL view fleet.v_machine_daily_hours implements the same rule; this JS version is
 * used to cross-check the database figures.
 */
function dailyRunSeconds(rows) {
  const byMachineDay = new Map();
  for (const r of rows) {
    const k = `${r.ref_no}|${r.event_time.slice(0, 10)}`;
    if (!byMachineDay.has(k)) byMachineDay.set(k, []);
    byMachineDay.get(k).push(r);
  }
  const out = [];
  for (const [k, rs] of byMachineDay) {
    rs.sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : a.run_hours_seconds - b.run_hours_seconds));
    let seconds = 0, resets = 0, capped = 0;
    for (let i = 1; i < rs.length; i++) {
      const delta = rs[i].run_hours_seconds - rs[i - 1].run_hours_seconds;
      const elapsed = (Date.parse(rs[i].event_time.replace(' ', 'T') + 'Z') - Date.parse(rs[i - 1].event_time.replace(' ', 'T') + 'Z')) / 1000;
      if (delta < 0) { resets++; continue; }
      if (delta > elapsed) capped++;
      seconds += Math.min(delta, elapsed);
    }
    const [ref_no, day] = k.split('|');
    out.push({ ref_no, day, run_seconds: seconds, run_hours: +(seconds / 3600).toFixed(2), counter_resets: resets, capped_intervals: capped });
  }
  return out.sort((a, b) => (a.day + a.ref_no).localeCompare(b.day + b.ref_no));
}

module.exports = { dailyRunSeconds };
