// /admin dashboard API: login, logout, stats.
// Credentials come ONLY from env vars ADMIN_EMAIL and ADMIN_PASSWORD (never in code).
// Sessions: HMAC-signed HttpOnly cookie, 7 days. Login lockout: 5 failures → 15 minutes.
import crypto from 'node:crypto';
import { getFails, setFails, clearFails, loadEvents, riyadhDay } from '../store.mjs';

const COOKIE = 'cubecv_admin';
const SESSION_SECONDS = 7 * 24 * 3600;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...headers },
  });

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function secret() {
  // Derived from the credentials, so changing the password signs everyone out.
  return process.env.ADMIN_SESSION_SECRET ||
    sha(`cubecv|${process.env.ADMIN_EMAIL}|${process.env.ADMIN_PASSWORD}`).toString('hex');
}
const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function makeSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function validSession(req) {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now() / 1000; } catch { return false; }
}

const cookieHeader = (value, maxAge, secure) =>
  `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

async function login(req, context) {
  const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return json({ error: 'not_configured' }, 503);

  const ip = context?.ip || 'unknown';
  const failKey = sha(ip).toString('hex').slice(0, 24);
  const fails = await getFails(failKey);
  if (fails.until > Date.now()) return json({ error: 'locked', retry_after_min: Math.ceil((fails.until - Date.now()) / 60000) }, 429);

  let body = {};
  try { const t = await req.text(); if (t.length > 1024) throw 0; body = JSON.parse(t); } catch { return json({ error: 'bad_request' }, 400); }
  const okEmail = safeEqual(String(body.email || '').trim().toLowerCase(), email.trim().toLowerCase());
  const okPass = safeEqual(String(body.password || ''), password);

  if (!(okEmail && okPass)) {
    fails.n = (fails.until && fails.until <= Date.now() ? 0 : fails.n) + 1;
    fails.until = fails.n >= MAX_FAILS ? Date.now() + LOCK_MS : 0;
    if (fails.until) fails.n = 0;
    await setFails(failKey, fails);
    await new Promise((r) => setTimeout(r, 400));
    return json({ error: 'invalid' }, 401);
  }
  await clearFails(failKey);
  const secure = new URL(req.url).protocol === 'https:';
  return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(makeSession(), SESSION_SECONDS, secure) });
}

function countBy(list, key) {
  const m = new Map();
  for (const e of list) { const k = e[key] || 'غير معروف'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
}

async function stats(req) {
  const days = [1, 7, 30, 90].includes(Number(new URL(req.url).searchParams.get('days')))
    ? Number(new URL(req.url).searchParams.get('days')) : 7;
  const events = await loadEvents(days);
  const views = events.filter((e) => e.type === 'view');
  const clicks = events.filter((e) => e.type === 'click');

  const daily = [];
  for (let d = days - 1; d >= 0; d--) {
    const day = riyadhDay(Date.now() - d * 86400000);
    daily.push({ day, views: views.filter((e) => e.day === day).length, clicks: clicks.filter((e) => e.day === day).length });
  }
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, clicks: 0 }));
  for (const e of clicks) hourly[new Date(e.ts + 3 * 3600000).getUTCHours()].clicks++;

  return json({
    days,
    generated_at: Date.now(),
    totals: {
      views: views.length,
      visitors: new Set(views.map((e) => e.visitor).filter(Boolean)).size,
      clicks: clicks.length,
      click_visitors: new Set(clicks.map((e) => e.visitor).filter(Boolean)).size,
      ad_views: views.filter((e) => e.ad).length,
      ad_clicks: clicks.filter((e) => e.ad).length,
    },
    daily,
    hourly,
    devices: countBy(clicks, 'device'),
    os: countBy(clicks, 'os'),
    countries: countBy(clicks, 'country'),
    cities: countBy(clicks, 'city'),
    sources: countBy(views.map((e) => ({ ...e, src: e.ad ? 'إعلان TikTok' : (e.ref || 'مباشر') })), 'src'),
    recent: clicks.slice(-50).reverse().map(({ ts, device, os, country, city, ad, ref }) => ({ ts, device, os, country, city, ad, ref })),
  });
}

export default async (req, context) => {
  const route = new URL(req.url).pathname.replace(/\/+$/, '');
  try {
    if (route === '/api/admin/login' && req.method === 'POST') return await login(req, context);
    if (route === '/api/admin/logout' && req.method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0, new URL(req.url).protocol === 'https:') });
    }
    if (route === '/api/admin/stats' && req.method === 'GET') {
      if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return json({ error: 'not_configured' }, 503);
      if (!validSession(req)) return json({ error: 'unauthorized' }, 401);
      return await stats(req);
    }
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    console.error('[admin-api] error:', err?.name || 'Error');
    return json({ error: 'server_error' }, 500);
  }
};

export const config = { path: ['/api/admin/login', '/api/admin/logout', '/api/admin/stats'] };
