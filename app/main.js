// Ridgeback Fleet front end. Talks only to the same-origin Vercel functions
// (/api/dashboard and /api/chat); n8n URLs and the webhook secret never reach the browser.

const API = { dashboard: '/api/dashboard', chat: '/api/chat' };
const BRANCHES = ['Airport', 'Harbour', 'Northgate', 'Riverside'];
const BRANCH_VAR = { Airport: '--b-airport', Harbour: '--b-harbour', Northgate: '--b-northgate', Riverside: '--b-riverside' };
const EVENT_TYPES = [
  ['impacts', 'Impact'],
  ['harsh_braking', 'Harsh braking'],
  ['harsh_acceleration', 'Harsh acceleration'],
  ['speeding', 'Speeding'],
  ['excess_idle', 'Excess idle'],
];
const REASON_TEXT = {
  duplicate_row_in_file: 'duplicate rows',
  repeated_header_row: 'repeated header row',
  wrong_column_count: 'broken line (wrong column count)',
  machine_not_in_machine_list: 'unknown machine',
  missing_required_value: 'missing values',
  invalid_timestamp: 'invalid timestamp',
  timestamp_after_file_delivery: 'timestamp after delivery',
  unknown_event_type: 'unknown event type',
  invalid_run_hours: 'invalid run hours',
};

const $ = (id) => document.getElementById(id);
const fmt1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const dayLong = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayShort = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const stamp = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' });
const asDate = (iso) => new Date(`${iso}T00:00:00Z`);

const state = { snapshot: null, days: [], charts: {}, controller: null };

/* ---------- Theme ---------- */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
$('theme-toggle').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('rb-theme', next); } catch (_) { /* storage unavailable */ }
  if (state.snapshot) renderCharts(state.snapshot);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.snapshot && renderCharts(state.snapshot));
matchMedia('(max-width: 560px)').addEventListener('change', () => state.snapshot && renderCharts(state.snapshot));

/* ---------- Small DOM helpers (all text via textContent) ---------- */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
  return n;
}
function table(headers, rows) {
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach(([label, isNum, cls]) => hr.append(el('th', { class: [isNum ? 'num' : '', cls || ''].join(' ').trim(), scope: 'col' }, label)));
  thead.append(hr);
  const tbody = el('tbody');
  rows.forEach((cells) => {
    const tr = el('tr');
    cells.forEach((c, i) => tr.append(el('td', { class: [headers[i][1] ? 'num' : '', headers[i][2] || ''].join(' ').trim() }, c)));
    tbody.append(tr);
  });
  t.append(thead, tbody);
  return t;
}
const icon = (ok) => {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('d', ok ? 'M3.5 8.5l3 3 6-7' : 'M4 4l8 8M12 4l-8 8');
  s.append(p);
  return s;
};

/* ---------- Data loading ---------- */
async function loadSnapshot(from = '', to = '') {
  state.controller?.abort();
  state.controller = new AbortController();
  const main = $('main');
  if (state.snapshot) main.classList.add('refreshing');
  const qs = from ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';
  try {
    const res = await fetch(`${API.dashboard}${qs}`, { signal: state.controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    if (!snap || !snap.kpis) throw new Error('Unexpected response');
    state.snapshot = snap;
    if (!state.days.length) buildPeriodOptions(snap);
    $('banner').hidden = true;
    render(snap);
  } catch (err) {
    if (err.name === 'AbortError') return;
    const b = $('banner');
    b.textContent = state.snapshot
      ? 'Could not refresh the dashboard. Showing the last figures loaded.'
      : 'The dashboard data could not be loaded right now. Please refresh in a minute.';
    b.hidden = false;
  } finally {
    main.classList.remove('refreshing');
    main.setAttribute('aria-busy', 'false');
  }
}

function buildPeriodOptions(snap) {
  state.days = [...new Set(snap.daily_hours_by_branch.map((r) => r.date))].sort();
  const sel = $('period');
  const first = state.days[0];
  const last = state.days[state.days.length - 1];
  sel.firstElementChild.textContent = `Whole week (${dayShort.format(asDate(first))} – ${dayShort.format(asDate(last))})`;
  for (const d of state.days) sel.append(el('option', { value: d }, dayLong.format(asDate(d))));
  sel.disabled = false;
  sel.addEventListener('change', () => {
    const d = sel.value;
    loadSnapshot(d, d);
  });
}

/* ---------- Rendering ---------- */
function render(s) {
  renderKpis(s);
  renderCharts(s);
  renderDrivers(s);
  renderQuality(s);
  const last = s.data_quality?.last_run_at;
  $('freshness').textContent = last ? `Last data load ${stamp.format(new Date(last))} SAST` : '';
}

function periodLabel(s) {
  const { from, to } = s.period;
  return from === to ? dayLong.format(asDate(from)) : `${dayShort.format(asDate(from))} – ${dayShort.format(asDate(to))}`;
}

function renderKpis(s) {
  const k = s.kpis;
  $('k-hours').textContent = fmt1.format(k.run_hours);
  $('k-hours-note').textContent = periodLabel(s);
  $('k-machines').textContent = `${k.active_machines} of ${k.total_machines}`;
  const idle = k.total_machines - k.active_machines;
  $('k-machines-note').textContent = idle ? `${idle} reported no activity` : 'every machine reported';
  $('k-events').textContent = fmt0.format(k.safety_events);
  $('k-events-note').textContent = k.run_hours ? `${fmt1.format(k.safety_events / k.run_hours)} per run hour` : ' ';
  $('k-impacts').textContent = fmt0.format(k.impacts);
  $('k-impacts-note').textContent = k.safety_events ? `${fmt0.format((k.impacts / k.safety_events) * 100)}% of safety events` : ' ';
  $('k-drivers').textContent = fmt0.format(k.active_drivers);
}

function chartTheme() {
  return {
    ink: css('--ink'), ink2: css('--ink-2'), muted: css('--muted'),
    grid: css('--grid'), axis: css('--axis'), surface: css('--surface'), seq: css('--seq'),
    branch: Object.fromEntries(BRANCHES.map((b) => [b, css(BRANCH_VAR[b])])),
  };
}

function baseOptions(t) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: t.surface, borderColor: t.axis, borderWidth: 1, padding: 10, cornerRadius: 8,
        titleColor: t.ink2, titleFont: { weight: '500', size: 12 },
        bodyColor: t.ink, bodyFont: { weight: '600', size: 13 }, boxWidth: 12, boxHeight: 2, boxPadding: 6,
        usePointStyle: false,
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.muted, font: { size: 12 } } },
      y: { beginAtZero: true, grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, font: { size: 12 }, maxTicksLimit: 6 } },
    },
  };
}

function legend(id, items, kind = 'sw') {
  const ul = $(id);
  ul.replaceChildren(...items.map(([label, color]) => el('li', {}, el('span', { class: kind, style: `background:${color}` }), label)));
}

function upsertChart(key, canvasId, config) {
  state.charts[key]?.destroy();
  state.charts[key] = new Chart($(canvasId), config);
}

function renderCharts(s) {
  const t = chartTheme();
  Chart.defaults.font.family = css('--font') || 'system-ui, sans-serif';
  Chart.defaults.color = t.muted;
  Chart.defaults.locale = 'en-GB'; // same decimal point everywhere, whatever the viewer's OS locale

  /* 1. Run hours by branch, per day */
  const days = [...new Set(s.daily_hours_by_branch.map((r) => r.date))].sort();
  const hoursAt = (b, d) => s.daily_hours_by_branch.find((r) => r.branch === b && r.date === d)?.hours ?? 0;
  const single = days.length <= 1;
  $('d-daily').textContent = single ? `Motor running time on ${periodLabel(s)}` : 'Motor running time per day';
  legend('legend-daily', BRANCHES.map((b) => [b, t.branch[b]]), single ? 'sw' : 'ln');
  const dailyOpts = baseOptions(t);
  dailyOpts.scales.y.title = { display: true, text: 'hours', color: t.muted, font: { size: 12 } };
  dailyOpts.plugins.tooltip.callbacks = { label: (c) => ` ${fmt1.format(c.parsed.y)} h  ${c.dataset.label}` };
  upsertChart('daily', 'c-daily', single
    ? {
        type: 'bar',
        data: {
          labels: BRANCHES,
          datasets: [{
            label: 'Run hours', data: BRANCHES.map((b) => hoursAt(b, days[0])),
            backgroundColor: BRANCHES.map((b) => t.branch[b]), maxBarThickness: 24,
            borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start',
          }],
        },
        options: { ...dailyOpts, interaction: { mode: 'nearest', intersect: true } },
      }
    : {
        type: 'line',
        data: {
          labels: days.map((d) => dayShort.format(asDate(d))),
          datasets: BRANCHES.map((b) => ({
            label: b, data: days.map((d) => hoursAt(b, d)),
            borderColor: t.branch[b], backgroundColor: t.branch[b], borderWidth: 2,
            pointRadius: 4, pointHoverRadius: 6, pointBorderColor: t.surface, pointBorderWidth: 2,
            tension: 0.25, borderCapStyle: 'round', borderJoinStyle: 'round',
          })),
        },
        options: dailyOpts,
        plugins: [crosshair(t)],
      });
  $('tbl-daily').replaceChildren(table(
    [['Day', false, 'nowrap'], ...BRANCHES.map((b) => [b, true]), ['Total', true]],
    days.map((d) => {
      const vals = BRANCHES.map((b) => hoursAt(b, d));
      return [dayLong.format(asDate(d)), ...vals.map((v) => fmt1.format(v)), fmt1.format(vals.reduce((a, v) => a + v, 0))];
    }),
  ));

  /* 2. Safety events: event type groups, one bar per branch (branch colours match chart 1) */
  legend('legend-safety', BRANCHES.map((b) => {
    const row = s.safety_by_branch.find((r) => r.branch === b);
    return [`${b} · ${fmt0.format(row?.total ?? 0)}`, t.branch[b]];
  }));
  const sOpts = baseOptions(t);
  sOpts.plugins.tooltip.callbacks = { label: (c) => ` ${fmt0.format(c.parsed.y)}  ${c.dataset.label}` };
  sOpts.scales.x.ticks.maxRotation = 0;
  sOpts.plugins.tooltip.callbacks.title = (items) => EVENT_TYPES[items[0].dataIndex][1];
  upsertChart('safety', 'c-safety', {
    type: 'bar',
    data: {
      labels: EVENT_TYPES.map(([, l]) => l.split(' ')),
      datasets: BRANCHES.map((b) => {
        const row = s.safety_by_branch.find((r) => r.branch === b) || {};
        return {
          label: b, data: EVENT_TYPES.map(([k]) => row[k] ?? 0), backgroundColor: t.branch[b],
          maxBarThickness: 16, barPercentage: 0.88, categoryPercentage: 0.8,
          borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start',
        };
      }),
    },
    options: sOpts,
  });
  $('tbl-safety').replaceChildren(table(
    [['Branch', false], ...EVENT_TYPES.map(([, l]) => [l, true]), ['Total', true]],
    BRANCHES.map((b) => {
      const r = s.safety_by_branch.find((x) => x.branch === b) || {};
      return [b, ...EVENT_TYPES.map(([k]) => fmt0.format(r[k] ?? 0)), fmt0.format(r.total ?? 0)];
    }),
  ));

  /* 3. Run hours by machine (single series, ranked) */
  const machines = [...s.machine_hours].sort((a, b) => b.hours - a.hours);
  const narrow = matchMedia('(max-width: 560px)').matches;
  const mOpts = baseOptions(t);
  mOpts.indexAxis = 'y';
  mOpts.interaction = { mode: 'nearest', axis: 'y', intersect: false };
  mOpts.layout = { padding: { right: 56 } };
  mOpts.scales = {
    x: { beginAtZero: true, grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, maxTicksLimit: 6 }, title: { display: true, text: 'hours', color: t.muted } },
    y: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.ink2, font: { size: narrow ? 11 : 12 }, autoSkip: false } },
  };
  mOpts.plugins.tooltip.callbacks = {
    title: (items) => { const m = machines[items[0].dataIndex]; return `${m.ref_no} · ${m.type} · ${m.branch}`; },
    label: (c) => ` ${fmt1.format(c.parsed.x)} run hours`,
  };
  upsertChart('machines', 'c-machines', {
    type: 'bar',
    data: {
      labels: machines.map((m) => (narrow ? m.ref_no : `${m.ref_no} · ${m.type}`)),
      datasets: [{
        label: 'Run hours', data: machines.map((m) => m.hours), backgroundColor: t.seq,
        maxBarThickness: 14, borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'start',
      }],
    },
    options: mOpts,
    plugins: [barEndLabels(t, (v) => (v > 0 ? fmt1.format(v) : 'no data'))],
  });
  $('tbl-machines').replaceChildren(table(
    [['Machine', false], ['Type', false], ['Branch', false], ['Run hours', true]],
    machines.map((m) => [m.ref_no, m.type, m.branch, fmt1.format(m.hours)]),
  ));
}

/* Vertical hairline that follows the hovered X on the line chart */
function crosshair(t) {
  return {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const active = chart.tooltip?.getActiveElements?.();
      if (!active?.length) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = t.axis;
      ctx.stroke();
      ctx.restore();
    },
  };
}

/* Value at the tip of each horizontal bar, in ink (never the series colour) */
function barEndLabels(t, format) {
  return {
    id: 'barEndLabels',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = `12px ${Chart.defaults.font.family}`;
      ctx.fillStyle = t.ink2;
      ctx.textBaseline = 'middle';
      meta.data.forEach((bar, i) => {
        const v = chart.data.datasets[0].data[i];
        ctx.fillText(format(v), bar.x + 6, bar.y);
      });
      ctx.restore();
    },
  };
}

function renderDrivers(s) {
  const rows = s.top_drivers || [];
  const max = Math.max(1, ...rows.map((r) => r.total_safety_events));
  const seq = css('--seq');
  $('tbl-drivers').replaceChildren(table(
    [['Driver', false, 'nowrap'], ['Safety events', true], ['Impacts', true], ['Run hours', true], ['Per run hour', true]],
    rows.map((r) => {
      const bar = el('span', { class: 'inline-bar' },
        el('i', { style: `width:${Math.round((r.total_safety_events / max) * 64)}px;background:${seq}` }),
        fmt0.format(r.total_safety_events));
      return [r.driver_name, bar, fmt0.format(r.impacts), fmt1.format(r.run_hours),
        r.run_hours > 0 ? fmt1.format(r.total_safety_events / r.run_hours) : '–'];
    }),
  ));
  const nd = s.data_quality?.events_without_driver ?? 0;
  $('drivers-note').textContent = nd
    ? `${nd} safety events happened before any driver logged on, so they are not credited to a person.`
    : '';
}

function renderQuality(s) {
  const dq = s.data_quality || { files: [] };
  const files = [...dq.files].sort((a, b) => a.data_day.localeCompare(b.data_day));
  const read = files.reduce((a, f) => a + (f.rows_read || 0), 0);
  const loaded = files.reduce((a, f) => a + (f.rows_loaded || 0), 0);
  const failed = files.filter((f) => f.status !== 'success').length;
  const expected = state.days.length ? state.days : files.map((f) => f.data_day);
  const missing = expected.filter((d) => !files.some((f) => f.data_day === d));

  const summary = [
    ['Files loaded', `${files.length - failed} of ${files.length}`],
    ['Rows read', fmt0.format(read)],
    ['Rows loaded', fmt0.format(loaded)],
    ['Rows rejected', fmt0.format(dq.rows_rejected ?? read - loaded)],
    ['Missing days', missing.length ? missing.map((d) => dayShort.format(asDate(d))).join(', ') : 'none'],
  ];
  $('dq-summary').replaceChildren(...summary.map(([k, v]) => el('span', {}, `${k}: `, el('strong', {}, v))));

  $('tbl-quality').replaceChildren(table(
    [['Data for', false, 'nowrap'], ['File', false, 'nowrap'], ['Status', false], ['Read', true], ['Loaded', true], ['Rejected', true], ['Why rows were rejected', false]],
    files.map((f) => {
      const ok = f.status === 'success';
      const status = el('span', { class: `status ${ok ? 'ok' : 'bad'}` }, icon(ok), ok ? 'Loaded' : 'Failed');
      const reasons = (f.rejection_reasons || '')
        .split(', ')
        .filter(Boolean)
        .map((r) => r.replace(/^([a-z_]+)/, (m) => REASON_TEXT[m] || m.replace(/_/g, ' ')))
        .join(', ');
      return [dayShort.format(asDate(f.data_day)), el('span', { class: 'muted' }, f.file_name), status,
        fmt0.format(f.rows_read), fmt0.format(f.rows_loaded), fmt0.format(f.rows_rejected), reasons || '–'];
    }),
  ));
}

/* Table toggles */
document.querySelectorAll('.table-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Chart' : 'Table';
    const key = btn.dataset.target;
    $(`tbl-${key}`).hidden = !open;
    $(`c-${key}`).parentElement.hidden = open;
    const lg = $(`legend-${key}`);
    if (lg) lg.hidden = open;
  });
});

/* ---------- Chat ---------- */
const sessionId = (() => {
  const make = () => (crypto.randomUUID ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(36).slice(2)}`);
  try {
    let id = sessionStorage.getItem('rb-session');
    if (!id) { id = make(); sessionStorage.setItem('rb-session', id); }
    return id;
  } catch (_) { return make(); }
})();

const messages = $('messages');
const input = $('question');
const sendBtn = $('send');

function addMessage(text, who, extra = '') {
  const m = el('div', { class: `msg ${who} ${extra}`.trim() }, text);
  messages.append(m);
  messages.scrollTop = messages.scrollHeight;
  return m;
}

async function ask(question) {
  const q = question.trim().slice(0, 500);
  if (!q || sendBtn.disabled) return;
  $('suggestions')?.remove();
  addMessage(q, 'user');
  input.value = '';
  updateCount();
  sendBtn.disabled = true;
  const pending = addMessage('Looking that up', 'bot', 'pending');
  try {
    const res = await fetch(API.chat, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ message: q, session_id: sessionId }),
    });
    const data = await res.json().catch(() => ({}));
    pending.remove();
    if (res.status === 429) addMessage('You are asking quickly. Please wait a few seconds and try again.', 'bot', 'error');
    else if (!res.ok || !data.answer) addMessage(data.error || 'Sorry, I could not get an answer just now. Please try again.', 'bot', 'error');
    else addMessage(data.answer, 'bot', data.error ? 'error' : '');
  } catch (_) {
    pending.remove();
    addMessage('Sorry, the assistant could not be reached. Check your connection and try again.', 'bot', 'error');
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

function updateCount() { $('count').textContent = `${input.value.length} / 500`; }
input.addEventListener('input', updateCount);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
});
$('composer').addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
$('suggestions').addEventListener('click', (e) => {
  if (e.target instanceof HTMLButtonElement) ask(e.target.textContent);
});

loadSnapshot();
