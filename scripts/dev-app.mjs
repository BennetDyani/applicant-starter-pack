// Local preview of the app (dashboard + chat) without a Vercel account.
// Serves app/ as static files and runs app/api/*.js the same way Vercel does.
// Secrets are read from app/.env.local (git-ignored). Usage: npm run dev:app
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const PORT = Number(process.env.PORT) || 3000;

// Minimal .env loader (KEY=value lines, # comments).
const envFile = path.join(APP, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const missing = ['N8N_DASHBOARD_URL', 'N8N_CHAT_URL', 'N8N_WEBHOOK_SECRET'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing ${missing.join(', ')}. Create app/.env.local (see .env.example).`);
  process.exit(1);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
      const file = path.join(APP, 'api', `${name}.js`);
      if (!name || name.startsWith('_') || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const mod = await import(pathToFileURL(file).href);
      req.query = Object.fromEntries(url.searchParams);
      return await mod.default(req, res);
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(APP, rel);
    if (!file.startsWith(APP + path.sep) || rel.includes('.env') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.writeHead(500); res.end('Server error'); }
  }
}).listen(PORT, () => console.log(`Ridgeback app running at http://localhost:${PORT}  (Ctrl+C to stop)`));
