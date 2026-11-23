// Handler: forwards the browser "Contact" event to TikTok Events API 2.0
// using the same event_id the Pixel used, so TikTok deduplicates the two copies.
// The access token is read only from the TIKTOK_EVENTS_API_ACCESS_TOKEN env var
// and is never returned, logged, or exposed to the browser.

import { recordEvent, deviceInfo, hostOf as refHost } from '../store.mjs';

const TIKTOK_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const DEFAULT_PIXEL_ID = 'D54MFLJC77U5DJL5074G';
const MAX_BODY_BYTES = 4096;
const ALLOWED_HOSTS = ['cubecv.site', 'www.cubecv.site'];

function hostAllowed(host) {
  if (!host) return false;
  host = host.toLowerCase();
  return ALLOWED_HOSTS.includes(host) ||
    host.endsWith('.cranl.net') ||            // CranL test URL
    host === 'localhost' || host === '127.0.0.1';
}

function hostOf(value) {
  try { return new URL(value).hostname; } catch { return ''; }
}

const str = (v, max, re) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && (!re || re.test(v)) ? v : undefined;

function validate(body, nowSec) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const event_id = str(body.event_id, 100, /^[A-Za-z0-9_.:-]+$/);
  const page_url = str(body.page_url, 2048);
  if (!event_id || !page_url || !hostAllowed(hostOf(page_url))) return null;

  let event_time = Number.isInteger(body.event_time) ? body.event_time : nowSec;
  if (Math.abs(nowSec - event_time) > 600) event_time = nowSec; // clamp bad/skewed clocks

  return {
    event_id,
    event_time,
    page_url,
    referrer: str(body.referrer, 2048),
    ttclid: str(body.ttclid, 512, /^[A-Za-z0-9_.\-~%]+$/),
    ttp: str(body.ttp, 256, /^[A-Za-z0-9_.\-~%|]+$/),
    visitor: str(body.visitor, 16, /^[a-z0-9]+$/),
  };
}

export default async (req, context) => {
  const ok = () => new Response(null, { status: 204 });

  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const origin = req.headers.get('origin') || req.headers.get('referer') || '';
  if (!hostAllowed(hostOf(origin))) return new Response('Forbidden', { status: 403 });

  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return new Response('Payload Too Large', { status: 413 });
    body = JSON.parse(text);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const data = validate(body, Math.floor(Date.now() / 1000));
  if (!data) return new Response('Bad Request', { status: 400 });

  // Dashboard record (independent of TikTok; failures are swallowed inside).
  await recordEvent({
    type: 'click',
    ...deviceInfo(req.headers.get('user-agent') || ''),
    country: context?.geo?.country?.code,
    city: context?.geo?.city,
    ad: !!data.ttclid,
    visitor: data.visitor,
    ref: refHost(data.referrer || ''),
  });

  const token = process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN;
  if (!token) {
    console.warn('[tiktok-contact] TIKTOK_EVENTS_API_ACCESS_TOKEN is not set; event skipped');
    return ok();
  }

  const user = {};
  if (data.ttclid) user.ttclid = data.ttclid;
  if (data.ttp) user.ttp = data.ttp;
  const ip = context?.ip || '';
  if (ip) user.ip = ip;
  const ua = req.headers.get('user-agent');
  if (ua) user.user_agent = ua.slice(0, 512);

  const page = { url: data.page_url };
  if (data.referrer) page.referrer = data.referrer;

  const payload = {
    event_source: 'web',
    event_source_id: process.env.TIKTOK_PIXEL_ID || DEFAULT_PIXEL_ID,
    data: [{
      event: 'Contact',
      event_time: data.event_time,
      event_id: data.event_id,
      user,
      page,
      properties: { content_id: 'whatsapp_contact', content_type: 'product' },
    }],
  };
  if (process.env.TIKTOK_TEST_EVENT_CODE) payload.test_event_code = process.env.TIKTOK_TEST_EVENT_CODE;

  try {
    const res = await fetch(TIKTOK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Access-Token': token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.code !== 0) {
      // Log only status and TikTok's message — never the token or user data.
      console.error('[tiktok-contact] TikTok API error', res.status, result.code, result.message);
    }
  } catch (err) {
    console.error('[tiktok-contact] request failed:', err?.name || 'Error');
  }
  return ok(); // the visitor never sees tracking errors
};

export const config = { path: '/api/tiktok-contact' };
