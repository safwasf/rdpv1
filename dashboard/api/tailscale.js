const { sendJson, requireDashboardKey } = require('../lib/api-helpers');

const BASE = 'https://api.tailscale.com';
const PREFIX = '/api/tailscale';

module.exports = async function tailscaleProxy(req, res) {
  if (!requireDashboardKey(req, res)) return;
  const method = String(req.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'DELETE'].includes(method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(res, 405, { message: 'Method not allowed.' });
  }

  const host = String(req.headers.host || 'localhost');
  const requestUrl = new URL(req.url, `https://${host}`);
  const suppliedPath = requestUrl.searchParams.get('path') || '';
  let targetUrl;
  try { targetUrl = new URL(suppliedPath, BASE); }
  catch (_) { return sendJson(res, 400, { message: 'Invalid Tailscale API path.' }); }
  if (targetUrl.origin !== BASE || !targetUrl.pathname.startsWith('/api/v2/') || targetUrl.pathname.includes('\\') || targetUrl.pathname.includes('..')) {
    return sendJson(res, 400, { message: 'Only Tailscale /api/v2 endpoints are allowed.' });
  }

  const auth = String(req.headers.authorization || '');
  if (!/^Bearer\s+\S+/i.test(auth)) return sendJson(res, 401, { message: 'A Tailscale API access token is required.' });
  let body = undefined;
  if (method !== 'GET' && method !== 'DELETE') {
    if (req.body && typeof req.body === 'object') body = JSON.stringify(req.body);
    else if (typeof req.body === 'string') body = req.body;
    else body = '';
  }
  try {
    const upstream = await fetch(targetUrl.toString(), {
      method,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': String(req.headers['content-type'] || 'application/json') } : {})
      },
      ...(body !== undefined ? { body } : {}),
      redirect: 'follow',
      cache: 'no-store'
    });
    const contentType = upstream.headers.get('content-type') || 'application/json';
    const text = upstream.status === 204 ? '' : await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.end(text);
  } catch (_) {
    sendJson(res, 502, { message: 'Could not connect to the Tailscale API.' });
  }
};
