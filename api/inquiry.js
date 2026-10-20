// POST /api/inquiry  — receive a project/speaking/funding inquiry and email it to Thomas.
// GET  /api/inquiry  — machine-readable description of the endpoint (for agents).
//
// Delivery uses FormSubmit (no account). The first real submission triggers a one-time
// activation email to the recipient address; click it once. Every valid inquiry is also
// written to the Vercel runtime logs so nothing is lost if email delivery fails.

const SITE = 'https://www.thomasjockin.com';
const TO = process.env.INQUIRY_TO_EMAIL || 'thomas@thomasjockin.com';

const TYPES = {
  'type-project': 'Type design / typography project',
  'speaking': 'Speaking, workshop, or teaching',
  'funding': 'Readex script funding',
  'other': 'Something else',
};

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

  const payload = {
    _subject: `[${TYPES[data.type]}] ${data.name} via thomasjockin.com`,
    _replyto: data.email,
    _template: 'table',
    _captcha: 'false',
    Type: TYPES[data.type],
    Name: data.name,
    Email: data.email,
    ...(data.organization && { Organization: data.organization }),
    ...(data.timeline && { Timeline: data.timeline }),
    ...(data.budget && { Budget: data.budget }),
    ...(data.script && { Script: data.script }),
    Message: data.message,
    'Reference': id + ' (' + via + ')',
  };

  try {
    const r = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(TO), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: SITE, Referer: SITE + '/' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || String(j.success) === 'false') throw new Error('delivery ' + r.status + ' ' + (j.message || ''));
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
