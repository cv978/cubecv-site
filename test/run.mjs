// End-to-end tests against a real Postgres engine (PGlite, in-process). No network:
// TikTok's API is mocked, and the admin credentials below are test-only values.
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'test-admin@example.test';
process.env.ADMIN_PASSWORD = 'local-test-pass-7781';
process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN = 'TEST_TOKEN_NOT_REAL';

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setDb, migrate } from '../src/store.mjs';

const pg = new PGlite();
setDb(pg);
await migrate();
await migrate(); // idempotent

const tiktok = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://business-api.tiktok.com/')) {
    tiktok.push({ headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ code: 0, message: 'OK' }), { status: 200 });
  }
  return realFetch(url, init);
};

const { server } = await import('../server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${server.address().port}`;
const O = { Origin: 'https://cubecv.site', 'X-Forwarded-For': '203.0.113.7', 'CF-IPCountry': 'SA' };
const post = (p, body, h = {}) => realFetch(B + p, { method: 'POST', headers: { ...O, ...h }, body: typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('✓', name); }

await t('landing page bytes are identical to the source page', async () => {
  const r = await realFetch(B + '/');
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), fs.readFileSync(new URL('../public/index.html', import.meta.url)));
});
await t('landing page keeps WhatsApp link and Pixel ID', async () => {
  const html = await (await realFetch(B + '/')).text();
  assert.ok(html.includes('href="https://wa.me/966540427988"'));
  assert.ok(html.includes("ttq.load('D54MFLJC77U5DJL5074G')"));
  assert.ok(!html.includes('ttq.identify'));
});
await t('/admin is served with noindex and no-store', async () => {
  const r = await realFetch(B + '/admin');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});
await t('www redirects to apex keeping ttclid', async () => {
  const r = await realFetch(B + '/?ttclid=abc', { headers: { 'X-Forwarded-Host': 'www.cubecv.site' }, redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://cubecv.site/?ttclid=abc');
});
await t('/healthz reports database ok', async () => {
  assert.deepEqual(await (await realFetch(B + '/healthz')).json(), { ok: true, db: true });
});
await t('unknown path is 404', async () => { assert.equal((await realFetch(B + '/package.json')).status, 404); });

await t('visit is recorded; bots and foreign origins are not', async () => {
  assert.equal((await post('/api/track-view', { visitor: 'v1', referrer: 'https://www.google.com/', ad: false }, { 'User-Agent': 'Mozilla/5.0 (iPhone) Mobile' })).status, 204);
  assert.equal((await post('/api/track-view', { visitor: 'v2', ad: true })).status, 204);
  assert.equal((await post('/api/track-view', { visitor: 'v3' }, { 'User-Agent': 'Googlebot/2.1' })).status, 204);
  assert.equal((await post('/api/track-view', {}, { Origin: 'https://other.example' })).status, 403);
  const { rows } = await pg.query("SELECT * FROM site_events WHERE type = 'view'");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].country, 'SA');
  assert.ok(rows.every((r) => !JSON.stringify(r).includes('203.0.113.7')), 'IP must not be stored');
});

await t('Contact: recorded and sent to TikTok with same event_id, IP, ttclid; no extra fields', async () => {
  const r = await post('/api/tiktok-contact', { event_id: 'contact_t1', page_url: 'https://cubecv.site/?ttclid=CL', ttclid: 'CL', ttp: 'TTP', visitor: 'v2', phone: '0500000000', cv: 'x' }, { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Mobile' });
  assert.equal(r.status, 204);
  assert.equal(tiktok.length, 1);
  const e = tiktok[0].body.data[0];
  assert.equal(tiktok[0].body.event_source_id, 'D54MFLJC77U5DJL5074G');
  assert.equal(e.event, 'Contact');
  assert.equal(e.event_id, 'contact_t1');
  assert.equal(e.user.ip, '203.0.113.7');
  assert.equal(e.user.ttclid, 'CL');
  assert.ok(!JSON.stringify(tiktok[0].body).includes('0500000000'));
  const { rows } = await pg.query("SELECT * FROM site_events WHERE type = 'click'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ad, true);
  assert.equal(rows[0].device, 'mobile');
});
await t('Contact validation rejects bad input', async () => {
  assert.equal((await post('/api/tiktok-contact', 'not json')).status, 400);
  assert.equal((await post('/api/tiktok-contact', { event_id: '<x>', page_url: 'https://cubecv.site/' })).status, 400);
  assert.equal((await post('/api/tiktok-contact', { event_id: 'ok_1', page_url: 'https://other.example/' })).status, 400);
  assert.equal((await post('/api/tiktok-contact', { event_id: 'ok_1', page_url: 'https://cubecv.site/' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await post('/api/tiktok-contact', 'x'.repeat(20000))).status, 413);
});
await t('Contact still succeeds for the visitor when TikTok fails', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('down'); };
  assert.equal((await post('/api/tiktok-contact', { event_id: 'contact_t2', page_url: 'https://cubecv.site/' })).status, 204);
  globalThis.fetch = saved;
});

await t('admin stats require a valid session', async () => {
  assert.equal((await realFetch(B + '/api/admin/stats')).status, 401);
  assert.equal((await realFetch(B + '/api/admin/stats', { headers: { Cookie: 'cubecv_admin=eyJleHAiOjk5OTk5OTk5OTl9.forged' } })).status, 401);
});
await t('login locks after 5 failures even with the right password', async () => {
  const h = { 'X-Forwarded-For': '198.51.100.9' };
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/admin/login', { email: 'test-admin@example.test', password: 'bad' }, h)).status, 401);
  assert.equal((await post('/api/admin/login', { email: 'test-admin@example.test', password: 'local-test-pass-7781' }, h)).status, 429);
});
let cookie;
await t('login works (email trimmed, case-insensitive) and sets a Secure HttpOnly cookie behind HTTPS proxy', async () => {
  const r = await post('/api/admin/login', { email: ' TEST-admin@example.test ', password: 'local-test-pass-7781' }, { 'X-Forwarded-Proto': 'https' });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Secure/);
  cookie = sc.split(';')[0];
});
await t('stats aggregate visits, clicks, ads and sources from Postgres', async () => {
  const j = await (await realFetch(B + '/api/admin/stats?days=7', { headers: { Cookie: cookie } })).json();
  assert.equal(j.totals.views, 2);
  assert.equal(j.totals.clicks, 2);
  assert.equal(j.totals.ad_views, 1);
  assert.equal(j.totals.ad_clicks, 1);
  assert.equal(j.daily.length, 7);
  assert.ok(j.sources.some((s) => s.name === 'google.com'));
  assert.equal(j.recent.length, 2);
});
await t('logout clears the cookie', async () => {
  const r = await post('/api/admin/logout', '');
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

server.close();
await pg.close();
console.log(`\n${passed} tests passed`);
