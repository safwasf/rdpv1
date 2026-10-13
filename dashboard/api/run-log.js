const JSZip = require('jszip');
const { parseRunnerLogs } = require('../lib/runner-log-parser');
const {
  sendJson, requirePost, requireDashboardKey,
  bearerToken, getBody, validateRepoSlug, githubJson, sendApiError
} = require('../lib/api-helpers');

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES    =  8 * 1024 * 1024;
const FETCH_TIMEOUT_MS  = 8000; // stay under Vercel's 10s limit

/* ── abort-signal helper ─────────────────────────────────────── */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

/* ── stream-safe body reader ─────────────────────────────────── */
async function readLimitedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw Object.assign(new Error('Response too large.'), { statusCode: 413 });
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch (_) {} throw Object.assign(new Error('Response too large.'), { statusCode: 413 }); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/* ── attempt 1: workflow log archive (ZIP, updated every 30s) ── */
async function fetchArchiveText(owner, repo, runId, token, debug) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/logs`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rdp-runner-dashboard' },
      redirect: 'follow', cache: 'no-store', signal: timeoutSignal(FETCH_TIMEOUT_MS)
    });
  } catch (fetchErr) {
    debug.archiveError = `fetch threw: ${fetchErr.message}`;
    return '';
  }

  debug.archiveStatus = response.status;
  debug.archiveFinalUrl = response.url ? response.url.split('?')[0] : ''; // strip query/tokens

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error(`GitHub archive returned ${response.status}`), { statusCode: response.status });
    }
    debug.archiveError = `HTTP ${response.status} — archive not ready`;
    return '';
  }

  let buf;
  try { buf = await readLimitedBody(response, MAX_ARCHIVE_BYTES); }
  catch (readErr) { debug.archiveError = `read: ${readErr.message}`; return ''; }

  debug.archiveSizeBytes = buf.length;

  let zip;
  try { zip = await JSZip.loadAsync(buf, { checkCRC32: false, createFolders: false }); }
  catch (zipErr) { debug.archiveError = `JSZip: ${zipErr.message}`; return ''; }

  const files = Object.values(zip.files).filter(f => !f.dir && /\.(txt|log)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  debug.archiveFileCount = files.length;

  let output = ''; let readBytes = 0;
  for (const file of files) {
    if (readBytes >= MAX_TEXT_BYTES) break;
    try {
      const content = await file.async('string');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (readBytes + bytes > MAX_TEXT_BYTES) continue;
      readBytes += bytes; output += `\n--- ${file.name} ---\n${content}\n`;
    } catch (_) {}
  }
  debug.archiveReadBytes = readBytes;
  return output;
}

/* ── attempt 2: individual job logs ─────────────────────────── */
async function fetchJobLogsText(owner, repo, runId, token, debug) {
  let jobsData;
  try {
    jobsData = await githubJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs?per_page=100`,
      token
    );
  } catch (e) {
    debug.jobsError = e.message;
    if (e.statusCode === 401 || e.statusCode === 403) throw e;
    return '';
  }

  const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
  debug.jobsFound = jobs.length;
  debug.jobStatuses = jobs.map(j => `${j.name}(${j.status})`);

  jobs.sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'));

  const results = await Promise.all(jobs.slice(0, 5).map(async job => {
    if (!job || !Number.isSafeInteger(Number(job.id))) return { id: job?.id, status: 'invalid-id', text: '' };
    let response;
    try {
      response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${Number(job.id)}/logs`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rdp-runner-dashboard' }, redirect: 'follow', cache: 'no-store', signal: timeoutSignal(FETCH_TIMEOUT_MS) }
      );
    } catch (e) { return { id: job.id, status: `fetch-err: ${e.message}`, text: '' }; }

    if (!response.ok) return { id: job.id, status: `HTTP ${response.status}`, text: '' };
    try {
      const text = (await readLimitedBody(response, MAX_TEXT_BYTES)).toString('utf8');
      return { id: job.id, status: `ok(${text.length}B)`, text: `\n--- JOB: ${job.name} (${job.status}) ---\n${text}` };
    } catch (e) { return { id: job.id, status: `read-err: ${e.message}`, text: '' }; }
  }));

  debug.jobLogResults = results.map(r => `${r.id}: ${r.status}`);
  return results.map(r => r.text).join('\n').slice(0, MAX_TEXT_BYTES);
}

/* ── main handler ────────────────────────────────────────────── */
module.exports = async function runLog(req, res) {
  if (!requirePost(req, res)) return;
  if (!requireDashboardKey(req, res)) return;

  const token = bearerToken(req);
  if (!token) return sendJson(res, 401, { message: 'A GitHub token is required.' });

  const body = getBody(req) || {};
  const parsedRepo = validateRepoSlug(body.repo);
  const runId = Number(body.runId);
  if (!parsedRepo) return sendJson(res, 400, { message: 'Repository must be owner/repo format.' });
  if (!Number.isSafeInteger(runId) || runId <= 0) return sendJson(res, 400, { message: 'Valid numeric runId required.' });

  const debug = {};

  try {
    let output = '';

    // 1️⃣ Try full archive
    try { output = await fetchArchiveText(parsedRepo.owner, parsedRepo.repo, runId, token, debug); }
    catch (e) { if (e.statusCode === 401 || e.statusCode === 403) throw e; }

    // 2️⃣ Fallback: per-job logs
    if (!output.trim()) {
      try { output = await fetchJobLogsText(parsedRepo.owner, parsedRepo.repo, runId, token, debug); }
      catch (e) { if (e.statusCode === 401 || e.statusCode === 403) throw e; }
    }

    // 3️⃣ Nothing yet
    if (!output.trim()) {
      return sendJson(res, 200, {
        repository: parsedRepo.slug, runId,
        details: {}, recentLines: [],
        message: 'No readable logs available yet.',
        _debug: debug
      });
    }

    const parsed = parseRunnerLogs(output);
    sendJson(res, 200, { repository: parsedRepo.slug, runId, ...parsed, _debug: debug });

  } catch (err) {
    sendApiError(res, err);
  }
};
