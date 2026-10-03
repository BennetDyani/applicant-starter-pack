// Shared helpers for the Vercel functions. Files starting with "_" are not routes.

/** Read a required environment variable, failing loudly in logs but not to the browser. */
export function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** Call an n8n webhook with the shared secret header and a hard timeout. */
export async function callN8n(url, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'x-ridgeback-key': env('N8N_WEBHOOK_SECRET'),
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort, per-instance rate limit (sliding window per IP).
 * Serverless instances do not share memory, so this only slows down bursts;
 * a production deployment would use a shared store (e.g. Upstash/Redis) or Vercel's firewall rules.
 */
const hits = new Map();
export function rateLimited(req, { limit, windowMs }) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > limit;
}

export function sendJson(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}
