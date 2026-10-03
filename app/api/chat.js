// POST /api/chat  { message: string (1-500 chars), session_id?: string }
// Proxies to the n8n "Fleet chat agent" webhook, adding the secret header server-side.
import { callN8n, env, rateLimited, sendJson } from './_shared.js';

const MAX_MESSAGE = 500;

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8_000) throw new Error('Body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return sendJson(res, 415, { error: 'Send JSON.' });
  }
  // Each question costs LLM tokens, so limit bursts per visitor.
  if (rateLimited(req, { limit: 10, windowMs: 60_000 })) {
    return sendJson(res, 429, { error: 'You are asking quickly. Please wait a few seconds and try again.' });
  }

  let body;
  try { body = await readJson(req); } catch { return sendJson(res, 400, { error: 'Invalid request.' }); }

  const message = String(body?.message ?? '').trim();
  if (!message) return sendJson(res, 400, { error: 'Please type a question.' });
  if (message.length > MAX_MESSAGE) return sendJson(res, 400, { error: `Please keep questions under ${MAX_MESSAGE} characters.` });
  const sessionId = String(body?.session_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

  try {
    const { status, data } = await callN8n(env('N8N_CHAT_URL'), {
      method: 'POST',
      body: { message, session_id: sessionId },
      timeoutMs: 45000,
    });
    if (status !== 200 || typeof data?.answer !== 'string') {
      console.error('chat upstream error', status);
      return sendJson(res, 502, { error: 'Sorry, I could not get an answer just now. Please try again.' });
    }
    return sendJson(res, 200, { answer: data.answer, error: Boolean(data.error) }, { 'cache-control': 'no-store' });
  } catch (err) {
    console.error('chat proxy failed', err?.name, err?.message);
    return sendJson(res, 504, { error: 'The assistant took too long to answer. Please try again.' });
  }
}
