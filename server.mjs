// cubecv.site server for CranL: serves the landing page unchanged, the /admin dashboard,
// and the tracking/admin APIs. The public page never depends on the database being up.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, ping } from './src/store.mjs';
import tiktokContact from './src/handlers/tiktok-contact.mjs';
import trackView from './src/handlers/track-view.mjs';
import adminApi from './src/handlers/admin-api.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const ROUTES = {
  '/api/tiktok-contact': tiktokContact,
  '/api/track-view': trackView,
  '/api/admin/login': adminApi,
  '/api/admin/logout': adminApi,
  '/api/admin/stats': adminApi,
};

// Files are read once at startup; the landing page bytes are served exactly as stored.
const PAGES = {
  '/': { file: 'public/index.html', admin: false },
  '/index.html': { file: 'public/index.html', admin: false },
  '/admin': { file: 'public/admin/index.html', admin: true },
  '/admin/': { file: 'public/admin/index.html', admin: true },
  '/admin/index.html': { file: 'public/admin/index.html', admin: true },
};
const cache = new Map();
for (const { file } of Object.values(PAGES)) if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(ROOT, file)));

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
const ADMIN_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(req.headers['x-real-ip'] || '') || req.socket.remoteAddress || '';
}
function geo(req) {
  const h = req.headers;
  const code = String(h['cf-ipcountry'] || h['x-country-code'] || h['x-geo-country'] || h['cloudfront-viewer-country'] || '').toUpperCase();
  const city = String(h['x-geo-city'] || h['cf-ipcity'] || h['cloudfront-viewer-city'] || '');
  return { country: { code: /^[A-Z]{2}$/.test(code) && code !== 'XX' ? code : '' }, city };
}

const MAX_BODY = 16 * 1024;
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
    const url = new URL(req.url || '/', `${proto}://${host}`);

    // www.cubecv.site → cubecv.site (keeps path and query, e.g. ttclid)
    if (url.hostname === 'www.cubecv.site') {
      res.writeHead(301, { Location: `https://cubecv.site${url.pathname}${url.search}` });
      return res.end();
    }

    if (url.pathname === '/healthz') {
      let db = false; try { await ping(); db = true; } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, db }));
    }

    const handler = ROUTES[url.pathname.replace(/\/+$/, '')];
    if (handler) {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const r = await handler(new Request(url, { method: req.method, headers, body }), { ip: clientIp(req), geo: geo(req) });
      const out = { ...BASE_HEADERS };
      r.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(r.status, out);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }

    const page = PAGES[url.pathname];
    if (page && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': page.admin ? 'no-store' : 'public, max-age=0, must-revalidate',
        ...BASE_HEADERS, ...(page.admin ? ADMIN_HEADERS : {}),
      });
      return res.end(req.method === 'HEAD' ? undefined : cache.get(page.file));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_HEADERS });
    res.end('Not Found');
  } catch (err) {
    const status = err?.status || 500;
    if (status === 500) console.error('[server] error:', err?.name || 'Error');
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(status === 413 ? 'Payload Too Large' : 'Server Error');
  }
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;

// Create tables in the background with retries; the page is served meanwhile.
async function migrateWithRetry(attempt = 1) {
  try { await migrate(); console.log('[db] ready'); }
  catch (err) {
    console.error(`[db] migrate failed (attempt ${attempt}):`, err?.code || err?.message || 'Error');
    setTimeout(() => migrateWithRetry(attempt + 1), Math.min(60000, attempt * 5000));
  }
}

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => console.log(`cubecv.site listening on ${HOST}:${PORT}`));
  migrateWithRetry();
}

export { server };
