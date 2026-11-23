// PostgreSQL storage for the /admin dashboard and the login lockout.
// No IP addresses, phone numbers or message contents are stored.
// `setDb()` lets tests inject an in-process Postgres (PGlite) with the same query() API.

const TZ_OFFSET_MS = 3 * 3600 * 1000; // Asia/Riyadh (UTC+3, no DST)
const RETENTION_DAYS = 400;

let db;
export function setDb(instance) { db = instance; }

async function getDb() {
  if (db) return db;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const { default: pg } = await import('pg');
  const ssl = /sslmode=(require|verify)/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined;
  db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000, ssl });
  db.on('error', (err) => console.error('[db] idle client error:', err?.code || err?.name || 'Error'));
  return db;
}

export async function migrate() {
  const d = await getDb();
  await d.query(`CREATE TABLE IF NOT EXISTS site_events (
    id BIGSERIAL PRIMARY KEY,
    ts BIGINT NOT NULL,
    type TEXT NOT NULL,
    device TEXT, os TEXT, country TEXT, city TEXT,
    ad BOOLEAN NOT NULL DEFAULT FALSE,
    visitor TEXT, ref TEXT
  )`);
  await d.query('CREATE INDEX IF NOT EXISTS site_events_ts_idx ON site_events (ts)');
  await d.query(`CREATE TABLE IF NOT EXISTS admin_login_fails (
    ip_hash TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    until BIGINT NOT NULL
  )`);
}

export async function ping() { await (await getDb()).query('SELECT 1'); }

export const riyadhDay = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
const clean = (v, max = 40) => {
  const s = String(v || '').replace(/[^A-Za-z0-9.\- ]/g, '').trim().slice(0, max);
  return s || null;
};

export function deviceInfo(ua = '') {
  const device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone|iPod/i.test(ua) ? 'mobile' : 'desktop';
  const os = /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android'
    : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'other';
  return { device, os };
}

export function hostOf(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// type: "view" | "click"
export async function recordEvent(ev) {
  try {
    const d = await getDb();
    await d.query(
      'INSERT INTO site_events (ts, type, device, os, country, city, ad, visitor, ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [Date.now(), ev.type === 'click' ? 'click' : 'view', clean(ev.device, 10), clean(ev.os, 10),
        clean(ev.country, 4), clean(ev.city, 40), !!ev.ad, clean(ev.visitor, 16), clean(ev.ref, 60)],
    );
    if (Math.random() < 0.01) {
      await d.query('DELETE FROM site_events WHERE ts < $1', [Date.now() - RETENTION_DAYS * 86400000]);
    }
  } catch (err) {
    console.error('[stats] record failed:', err?.code || err?.name || 'Error'); // never break the caller
  }
}

// Events in the last `days` Riyadh days (today included).
export async function loadEvents(days) {
  const d = await getDb();
  const fromDay = riyadhDay(Date.now() - (days - 1) * 86400000);
  const fromTs = Date.parse(fromDay + 'T00:00:00Z') - TZ_OFFSET_MS;
  const { rows } = await d.query(
    'SELECT ts, type, device, os, country, city, ad, visitor, ref FROM site_events WHERE ts >= $1 ORDER BY ts ASC',
    [fromTs],
  );
  return rows.map((r) => ({
    ts: Number(r.ts), type: r.type, device: r.device || '', os: r.os || '', country: r.country || '',
    city: r.city || '', ad: !!r.ad, visitor: r.visitor || '', ref: r.ref || '', day: riyadhDay(Number(r.ts)),
  }));
}

export async function getFails(ipHash) {
  const { rows } = await (await getDb()).query('SELECT n, until FROM admin_login_fails WHERE ip_hash = $1', [ipHash]);
  return rows[0] ? { n: Number(rows[0].n), until: Number(rows[0].until) } : { n: 0, until: 0 };
}
export async function setFails(ipHash, f) {
  await (await getDb()).query(
    'INSERT INTO admin_login_fails (ip_hash, n, until) VALUES ($1,$2,$3) ON CONFLICT (ip_hash) DO UPDATE SET n = EXCLUDED.n, until = EXCLUDED.until',
    [ipHash, f.n, f.until],
  );
}
export async function clearFails(ipHash) {
  await (await getDb()).query('DELETE FROM admin_login_fails WHERE ip_hash = $1', [ipHash]);
}
