// POST /api/inquiry  — receive a project/speaking/funding inquiry and email it to Thomas.
// GET  /api/inquiry  — machine-readable description of the endpoint (for agents).
//
// Delivery uses Resend (env var RESEND_API_KEY). Until a sending domain is verified in Resend,
// Resend only delivers to the account owner's address, which is what INQUIRY_TO_EMAIL should be.
// Every valid inquiry is also written to the Vercel runtime logs so nothing is lost if email fails.

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

  const lines = [
    `Type: ${TYPES[data.type]}`,
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    data.organization && `Organization: ${data.organization}`,
    data.timeline && `Timeline: ${data.timeline}`,
    data.budget && `Budget: ${data.budget}`,
    data.script && `Script: ${data.script}`,
    '',
    data.message,
    '',
    `Reference: ${id} (${via}). Reply to this email to answer ${data.name}.`,
  ].filter((l) => l !== '' ? Boolean(l) : true);

  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY is not set');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'thomasjockin.com <onboarding@resend.dev>',
        to: [TO],
        reply_to: data.email,
        subject: `[${TYPES[data.type]}] ${data.name} via thomasjockin.com`,
        text: lines.join('\n'),
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
