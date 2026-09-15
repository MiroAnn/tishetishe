const ALLOWED_ORIGINS = new Set([
  'https://miroann.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

const TELEGRAM_RE = /^@[A-Za-z0-9_]{5,32}$/;
const TARIFFS = {
  '1': { amount: 5900, paymentUrl: 'https://payform.ru/awcyQkO/' },
  '2': { amount: 9000, paymentUrl: 'https://payform.ru/fkcyQnh/' },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === '/lead' && request.method === 'POST') {
        return await createLead(request, env, cors);
      }
      if (url.pathname === '/prodamus' && request.method === 'POST') {
        return await handleProdamus(request, env, url);
      }
      if (url.pathname === '/export.csv' && request.method === 'GET') {
        return await exportCsv(request, env, url);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (error) {
      console.error(error);
      return json({ error: 'Internal error' }, 500, cors);
    }
  },
};

async function createLead(request, env, cors) {
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: 'Origin is not allowed' }, 403, cors);
  }

  const body = await request.json();
  const telegram = String(body.telegram || '').trim();
  const tariff = String(body.tariff || '');
  const tariffConfig = TARIFFS[tariff];
  if (!TELEGRAM_RE.test(telegram) || !tariffConfig) {
    return json({ error: 'Invalid lead data' }, 400, cors);
  }

  const id = `rq_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const utm = body.utm || {};
  await env.DB.prepare(`
    INSERT INTO leads (
      id, created_at, telegram, tariff, amount, status, source_url, referrer,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'checkout_started', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, now, telegram, tariff, tariffConfig.amount,
    clean(body.sourceUrl), clean(body.referrer), clean(utm.source), clean(utm.medium),
    clean(utm.campaign), clean(utm.content), clean(utm.term), now,
  ).run();

  return json({ leadId: id, paymentUrl: tariffConfig.paymentUrl }, 201, cors);
}

async function handleProdamus(request, env, url) {
  if (!env.WEBHOOK_TOKEN || url.searchParams.get('token') !== env.WEBHOOK_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }

  const form = await request.formData();
  const flat = Object.fromEntries(form.entries());
  const payload = formDataToObject(form);
  const signature = request.headers.get('Sign') || request.headers.get('sign');
  if (env.PRODAMUS_SECRET && !(await verifyProdamus(payload, env.PRODAMUS_SECRET, signature))) {
    return new Response('Invalid signature', { status: 401 });
  }

  const orderId = String(flat.order_id || '');
  if (!orderId.startsWith('rq_')) return new Response('Ignored', { status: 200 });

  const paymentStatus = String(flat.payment_status || '');
  const status = paymentStatus === 'success' ? 'paid' : paymentStatus || 'notification_received';
  const paidAt = paymentStatus === 'success' ? String(flat.date || new Date().toISOString()) : null;
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE leads SET
      status = ?, paid_at = COALESCE(?, paid_at), payment_id = ?, payment_status = ?,
      payment_method = ?, customer_email = ?, customer_phone = ?, webhook_payload = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    status, paidAt, clean(flat.order_id), paymentStatus, clean(flat.payment_type),
    clean(flat.customer_email), clean(flat.customer_phone), JSON.stringify(payload), now, orderId,
  ).run();

  return new Response('success', { status: 200 });
}

async function exportCsv(request, env, url) {
  if (!env.EXPORT_TOKEN || url.searchParams.get('token') !== env.EXPORT_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }

  const { results } = await env.DB.prepare(`
    SELECT created_at, telegram, tariff, amount, status, paid_at, payment_id,
      payment_method, customer_email, customer_phone, utm_source, utm_medium,
      utm_campaign, utm_content, utm_term, source_url, referrer, id
    FROM leads ORDER BY created_at DESC
  `).all();
  const columns = [
    'created_at', 'telegram', 'tariff', 'amount', 'status', 'paid_at', 'payment_id',
    'payment_method', 'customer_email', 'customer_phone', 'utm_source', 'utm_medium',
    'utm_campaign', 'utm_content', 'utm_term', 'source_url', 'referrer', 'id',
  ];
  const rows = [columns.join(';'), ...results.map((row) => columns.map((key) => csvCell(row[key])).join(';'))];
  return new Response(`\uFEFF${rows.join('\r\n')}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ksenia-payments.csv"',
      'Cache-Control': 'no-store',
    },
  });
}

async function verifyProdamus(data, secret, signature) {
  if (!signature) return false;
  const normalized = deepSortAndStringify(data);
  const jsonPayload = JSON.stringify(normalized).replace(/\//g, '\\/');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(jsonPayload));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, signature.toLowerCase());
}

function deepSortAndStringify(value) {
  if (Array.isArray(value)) return value.map(deepSortAndStringify);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, deepSortAndStringify(value[key])]));
  }
  return String(value ?? '');
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function formDataToObject(form) {
  const result = {};
  for (const [rawKey, rawValue] of form.entries()) {
    const keys = rawKey.replace(/\]/g, '').split('[');
    let cursor = result;
    keys.forEach((key, index) => {
      const isLast = index === keys.length - 1;
      if (isLast) {
        cursor[key] = String(rawValue);
        return;
      }
      const nextIsArray = /^\d+$/.test(keys[index + 1]);
      if (cursor[key] == null) cursor[key] = nextIsArray ? [] : {};
      cursor = cursor[key];
    });
  }
  return result;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://miroann.github.io';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(value, status, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function clean(value) {
  return value == null ? null : String(value).slice(0, 1000);
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}
