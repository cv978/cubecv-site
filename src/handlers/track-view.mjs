// Records one page visit for the /admin dashboard. No IP or personal data is stored.
import { recordEvent, deviceInfo, hostOf } from '../store.mjs';

const ALLOWED = (h) => ['cubecv.site', 'localhost', '127.0.0.1'].includes(h) || h.endsWith('.cranl.net');
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|headless|lighthouse|preview/i;

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!ALLOWED(hostOf(req.headers.get('origin') || req.headers.get('referer') || ''))) {
    return new Response('Forbidden', { status: 403 });
  }
  let body = {};
  try {
    const text = await req.text();
    if (text.length > 2048) return new Response('Payload Too Large', { status: 413 });
    body = JSON.parse(text || '{}');
  } catch { return new Response('Bad Request', { status: 400 }); }

  const ua = req.headers.get('user-agent') || '';
  if (BOT.test(ua)) return new Response(null, { status: 204 });

  const visitor = typeof body.visitor === 'string' && /^[a-z0-9]{1,16}$/.test(body.visitor) ? body.visitor : '';
  const referrer = typeof body.referrer === 'string' ? body.referrer.slice(0, 2048) : '';
  const ref = hostOf(referrer);

  await recordEvent({
    type: 'view',
    ...deviceInfo(ua),
    country: context?.geo?.country?.code,
    city: context?.geo?.city,
    ad: body.ad === true,
    visitor,
    ref: ref === 'cubecv.site' ? '' : ref,
  });
  return new Response(null, { status: 204 });
};

export const config = { path: '/api/track-view' };
