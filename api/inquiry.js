// POST /api/inquiry  — receive a project/speaking/funding inquiry and email it to Thomas.
// GET  /api/inquiry  — machine-readable description of the endpoint (for agents).
//
// Delivery uses Resend (env var RESEND_API_KEY) with the verified thomasjockin.com domain.
// Optional env vars: INQUIRY_TO_EMAIL (recipient), INQUIRY_FROM (sender).
// Every valid inquiry is also written to the Vercel runtime logs so nothing is lost if email fails.

const SITE = 'https://www.thomasjockin.com';
const TO = process.env.INQUIRY_TO_EMAIL || 'thomas@thomasjockin.com';
const FROM = process.env.INQUIRY_FROM || 'thomasjockin.com <inquiries@thomasjockin.com>';

const TYPES = {
  'type-project': 'Type design / typography project',
  'speaking': 'Speaking, workshop, or teaching',
  'funding': 'Readex script funding',
  'other': 'Something else',
};

const TYPE_TAGS = { 'type-project': 'Type project', speaking: 'Speaking', funding: 'Funding', other: 'Inquiry' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LIMITS = { name: 120, email: 254, organization: 160, message: 5000, detail: 300 };

const DESCRIPTION = {
  name: 'Thomas Jockin inquiry endpoint',
  about: 'Send an inquiry to Thomas Jockin (type designer, educator, writer, founder of TypeThursday). Inquiries are emailed to Thomas, who replies personally. Submitting does not commit Thomas or the sender to anything.',
  method: 'POST',
  url: SITE + '/api/inquiry',
  contentType: ['application/json', 'application/x-www-form-urlencoded'],
  fields: {
    type: { required: true, enum: Object.keys(TYPES), meaning: TYPES },
    name: { required: true, maxLength: LIMITS.name },
    email: { required: true, format: 'email', note: 'Where Thomas should reply.' },
    message: { required: true, minLength: 10, maxLength: LIMITS.message },
    organization: { required: false, maxLength: LIMITS.organization },
    timeline: { required: false, maxLength: LIMITS.detail, note: 'e.g. when the work is needed or the event date.' },
    budget: { required: false, maxLength: LIMITS.detail, note: 'Optional range, for type projects.' },
    script: { required: false, maxLength: LIMITS.detail, note: 'For funding inquiries: which script (e.g. Hangul, Armenian, Cyrillic, Greek, Tamil, N. American).' },
    website: { required: false, note: 'Leave empty. Anti-spam field; submissions with a value are discarded.' },
  },
  responses: { 200: 'Received', 400: 'Validation error (see "errors")', 405: 'Method not allowed', 429: 'Too many requests', 502: 'Delivery failed; use the "fallback" mailto address' },
  openapi: SITE + '/openapi.json',
};

// Best-effort, per-instance rate limit (resets on cold start).
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 5;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 500) for (const [k, v] of hits) if (!v.some((t) => now - t < win)) hits.delete(k);
  return arr.length > max;
}

const clean = (v, max) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max) : '';

function parseBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch (_) {
      try { return Object.fromEntries(new URLSearchParams(b)); } catch (_) { return {}; }
    }
  }
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json(DESCRIPTION);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST (see GET for the schema).' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ ok: false, error: 'Too many requests. Please try again later.' });

  const body = parseBody(req);

  // Honeypot: pretend success, deliver nothing.
  if (clean(body.website, 200)) return res.status(200).json({ ok: true, message: 'Received.' });

  const data = {
    type: clean(body.type, 40) || 'other',
    name: clean(body.name, LIMITS.name),
    email: clean(body.email, LIMITS.email),
    organization: clean(body.organization, LIMITS.organization),
    message: clean(body.message, LIMITS.message),
    timeline: clean(body.timeline, LIMITS.detail),
    budget: clean(body.budget, LIMITS.detail),
    script: clean(body.script, LIMITS.detail),
  };

  const errors = [];
  if (!TYPES[data.type]) errors.push('type must be one of: ' + Object.keys(TYPES).join(', '));
  if (!data.name) errors.push('name is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) errors.push('a valid email is required');
  if (data.message.length < 10) errors.push('message must be at least 10 characters');
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const id = 'inq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const via = /Mozilla/i.test(String(req.headers['user-agent'] || '')) ? 'browser' : 'api';

  // Durable fallback record (visible in Vercel runtime logs).
  console.log('INQUIRY ' + JSON.stringify({ id, via, ip, ...data }));

  const subject = `${TYPE_TAGS[data.type]}: ${data.name}${data.organization ? ' (' + data.organization + ')' : ''}`;
  const replySubject = 'Re: ' + TYPES[data.type] + ' — thomasjockin.com';
  const replyHref = `mailto:${data.email}?subject=${encodeURIComponent(replySubject)}&body=${encodeURIComponent('Hi ' + data.name.split(' ')[0] + ',\n\n')}`;
  const details = [
    ['Topic', TYPES[data.type]],
    ['Organization', data.organization],
    ['Timeline', data.timeline],
    ['Budget', data.budget],
    ['Script', data.script],
  ].filter(([, v]) => v);

  const text = [
    `NEW INQUIRY: ${TYPES[data.type]}`,
    '',
    `From: ${data.name} <${data.email}>`,
    ...details.filter(([k]) => k !== 'Topic').map(([k, v]) => `${k}: ${v}`),
    '',
    'MESSAGE',
    data.message,
    '',
    `Reply to this email to answer ${data.name} (Reply-To is set to ${data.email}).`,
    `Ref ${id} via ${via}`,
  ].join('\n');

  const rows = details.map(([k, v]) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#6b6b66;font-size:13px;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;font-size:14px;color:#14161a">${esc(v)}</td></tr>`).join('');

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f2ec">
<div style="max-width:560px;margin:0 auto;padding:20px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#14161a">
  <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b6b66;margin-bottom:6px">New inquiry · thomasjockin.com</div>
  <div style="font-size:22px;font-weight:600;line-height:1.25;margin-bottom:16px">${esc(TYPES[data.type])}</div>
  <div style="background:#ffffff;border:1px solid #d6d2c4;border-radius:6px;padding:16px;margin-bottom:12px">
    <div style="font-size:16px;font-weight:600">${esc(data.name)}</div>
    <div style="font-size:14px;margin:2px 0 12px"><a href="mailto:${esc(data.email)}" style="color:#1f5f4e">${esc(data.email)}</a></div>
    <table role="presentation" style="border-collapse:collapse">${rows}</table>
  </div>
  <div style="background:#ffffff;border:1px solid #d6d2c4;border-left:3px solid #1f5f4e;border-radius:6px;padding:16px;margin-bottom:16px">
    <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b6b66;margin-bottom:8px">Message</div>
    <div style="font-size:15px;line-height:1.55;white-space:pre-wrap">${esc(data.message)}</div>
  </div>
  <a href="${replyHref}" style="display:inline-block;background:#14161a;color:#f4f2ec;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:999px">Reply to ${esc(data.name.split(' ')[0])}</a>
  <div style="font-size:12px;color:#8a8a84;margin-top:20px;line-height:1.5">Or just hit Reply: it goes to ${esc(data.email)}.<br>Ref ${esc(id)} · sent via ${esc(via)}</div>
</div></body></html>`;

  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY is not set');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: data.email,
        subject,
        text,
        html,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error('delivery ' + r.status + ' ' + (j.message || j.name || ''));
    }
  } catch (err) {
    console.error('INQUIRY_DELIVERY_FAILED ' + id + ' ' + err.message);
    return res.status(502).json({
      ok: false,
      id,
      error: 'Your inquiry was recorded but email delivery failed. Please email Thomas directly.',
      fallback: 'mailto:' + TO,
    });
  }

  return res.status(200).json({ ok: true, id, message: 'Received. Thomas will reply to ' + data.email + ' personally.' });
};
