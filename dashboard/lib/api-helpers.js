const crypto = require('node:crypto');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.end(JSON.stringify(body));
}

function requirePost(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { message: 'Use POST for this endpoint.' });
    return false;
  }
  return true;
}

function requireDashboardKey(req, res) {
  const expected = process.env.DASHBOARD_ACCESS_KEY || '';
  if (expected.length < 20) {
    sendJson(res, 503, { code: 'DASHBOARD_CONFIG', message: 'Set DASHBOARD_ACCESS_KEY in Vercel → Project Settings → Environment Variables. Use a random value with at least 20 characters, then redeploy.' });
    return false;
  }
  const supplied = String(req.headers['x-dashboard-key'] || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  const okay = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!okay) {
    sendJson(res, 401, { code: 'DASHBOARD_AUTH', message: 'Dashboard access key missing or invalid.' });
    return false;
  }
  return true;
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return match ? match[1].trim() : '';
}

function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return null; }
  }
  return null;
}

function validateRepoSlug(value) {
  const slug = String(value || '').trim();
  const parts = slug.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts.some(p => !/^[A-Za-z0-9_.-]+$/.test(p) || p === '.' || p === '..')) return null;
  return { owner: parts[0], repo: parts[1], slug: `${parts[0]}/${parts[1]}` };
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'actions-running-runners-dashboard'
    },
    cache: 'no-store',
    redirect: 'follow'
  });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const message = data && typeof data.message === 'string' ? data.message : `GitHub API returned HTTP ${response.status}.`;
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }
  return data || {};
}

function sendApiError(res, error) {
  // Deliberately never include request headers, tokens, signed log URLs, or raw log data.
  const status = Number(error && error.statusCode) || 500;
  let message = error && error.message ? String(error.message) : 'Unexpected server error.';
  if (status === 401) message = 'GitHub rejected the supplied token. Verify the saved token.';
  if (status === 403) message = 'GitHub denied access. The token needs access to this repository and Actions read permission; also check API rate limits.';
  if (status === 404) message = 'Repository, workflow run, or log archive not found. The run may have ended or logs may have expired.';
  sendJson(res, status >= 400 && status <= 599 ? status : 500, { message });
}

module.exports = { sendJson, requirePost, requireDashboardKey, bearerToken, getBody, validateRepoSlug, githubJson, sendApiError };
