// GET /api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD
// Proxies to the n8n "Dashboard API" webhook, adding the secret header server-side.
import { callN8n, env, rateLimited, sendJson } from './_shared.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'GET' });
  if (rateLimited(req, { limit: 60, windowMs: 60_000 })) return sendJson(res, 429, { error: 'Too many requests' });

  const url = new URL(env('N8N_DASHBOARD_URL'));
  const { from, to } = req.query || {};
  // Only pass through well-formed dates; anything else is ignored (whole period).
  if (ISO_DATE.test(String(from ?? '')) && ISO_DATE.test(String(to ?? '')) && from <= to) {
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
  }

  try {
    const { status, data } = await callN8n(url.toString(), { timeoutMs: 15000 });
    if (status !== 200 || !data?.kpis) {
      console.error('dashboard upstream error', status);
      return sendJson(res, 502, { error: 'Dashboard data is unavailable right now.' });
    }
    // Data changes once a day (04:00 load), so a short CDN cache is safe and cheap.
    return sendJson(res, 200, data, { 'cache-control': 'public, s-maxage=300, stale-while-revalidate=600' });
  } catch (err) {
    console.error('dashboard proxy failed', err?.name, err?.message);
    return sendJson(res, 504, { error: 'Dashboard data is unavailable right now.' });
  }
}
