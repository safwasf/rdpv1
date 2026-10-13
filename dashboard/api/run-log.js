const JSZip = require('jszip');
const { parseRunnerLogs } = require('../lib/runner-log-parser');
const {
  sendJson, requirePost, requireDashboardKey,
  bearerToken, getBody, validateRepoSlug, githubJson, sendApiError
} = require('../lib/api-helpers');

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES    =  8 * 1024 * 1024;
const FETCH_TIMEOUT_MS  = 8000;
const STATUS_FILE_MAX_AGE_MS = 12 * 60 * 1000; // 12 minutes (pushed every 5 min)

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), ms); return ctrl.signal;
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw Object.assign(new Error('Response too large.'), { statusCode: 413 });
    return buf;
  }
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break; total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch (_) {} throw Object.assign(new Error('Response too large.'), { statusCode: 413 }); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/* ── PRIMARY: read rdp-status.json written by the workflow ───── */
async function fetchStatusFile(owner, repo, runId, token, debug) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/rdp-status/${runId}.json`;
  let data;
  try { data = await githubJson(url, token); }
  catch (e) { debug.statusFileError = e.message; if (e.statusCode === 401 || e.statusCode === 403) throw e; return null; }

  if (!data || !data.content) { debug.statusFileError = 'no content'; return null; }

  let status;
  try {
    const raw = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
    status = JSON.parse(raw);
  } catch (e) { debug.statusFileError = `parse: ${e.message}`; return null; }

  // Must match the requested runId
  if (String(status.runId) !== String(runId)) {
    debug.statusFileError = `runId mismatch (file=${status.runId}, req=${runId})`;
    return null;
  }

  // Must not be stale
  const ageMs = Date.now() - new Date(status.updatedAt || 0).getTime();
  if (ageMs > STATUS_FILE_MAX_AGE_MS) {
    debug.statusFileError = `stale (${Math.round(ageMs / 60000)}min old)`;
    return null;
  }

  if (status.status === 'ended') { debug.statusFileError = 'session ended'; return null; }

  debug.statusFileUsed = true;
  debug.statusFileAgeSeconds = Math.round(ageMs / 1000);
  return status;
}

/* ── FALLBACK 1: workflow log archive (ZIP) ─────────────────── */
async function fetchArchiveText(owner, repo, runId, token, debug) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/logs`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rdp-runner-dashboard' },
      redirect: 'follow', cache: 'no-store', signal: timeoutSignal(FETCH_TIMEOUT_MS)
    });
  } catch (e) { debug.archiveError = `fetch: ${e.message}`; return ''; }

  debug.archiveStatus = response.status;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error(`Archive HTTP ${response.status}`), { statusCode: response.status });
    debug.archiveError = `HTTP ${response.status}`;
    return '';
  }

  let buf;
  try { buf = await readLimitedBody(response, MAX_ARCHIVE_BYTES); }
  catch (e) { debug.archiveError = `read: ${e.message}`; return ''; }
  debug.archiveSizeBytes = buf.length;

  let zip;
  try { zip = await JSZip.loadAsync(buf, { checkCRC32: false, createFolders: false }); }
  catch (e) { debug.archiveError = `zip: ${e.message}`; return ''; }

  const files = Object.values(zip.files).filter(f => !f.dir && /\.(txt|log)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  debug.archiveFiles = files.length;
  let output = ''; let readBytes = 0;
  for (const file of files) {
    if (readBytes >= MAX_TEXT_BYTES) break;
    try { const c = await file.async('string'); const b = Buffer.byteLength(c, 'utf8'); if (readBytes + b <= MAX_TEXT_BYTES) { readBytes += b; output += `\n--- ${file.name} ---\n${c}\n`; } }
    catch (_) {}
  }
  return output;
}

/* ── FALLBACK 2: individual job logs ────────────────────────── */
async function fetchJobLogsText(owner, repo, runId, token, debug) {
  let jobsData;
  try { jobsData = await githubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs?per_page=100`, token); }
  catch (e) { debug.jobsError = e.message; if (e.statusCode === 401 || e.statusCode === 403) throw e; return ''; }

  const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
  debug.jobsFound = jobs.length;
  jobs.sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'));

  const results = await Promise.all(jobs.slice(0, 5).map(async job => {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${Number(job.id)}/logs`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rdp-runner-dashboard' }, redirect: 'follow', cache: 'no-store', signal: timeoutSignal(FETCH_TIMEOUT_MS) }
      );
      if (!response.ok) return '';
      const text = (await readLimitedBody(response, MAX_TEXT_BYTES)).toString('utf8');
      return `\n--- JOB: ${job.name} ---\n${text}`;
    } catch (_) { return ''; }
  }));

  return results.join('\n').slice(0, MAX_TEXT_BYTES);
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
    // ── 1. rdp-status.json (written by workflow every 5 min) ──
    const statusFile = await fetchStatusFile(parsedRepo.owner, parsedRepo.repo, runId, token, debug);
    if (statusFile) {
      const minLeft = typeof statusFile.restartingIn === 'number' ? statusFile.restartingIn : '?';
      const aliveAt = statusFile.aliveAt || statusFile.updatedAt || '';
      const timeStr = aliveAt ? new Date(aliveAt).toISOString().slice(11, 19) : '';
      return sendJson(res, 200, {
        repository: parsedRepo.slug, runId,
        details: {
          cpu:      String(statusFile.cpu      || ''),
          cores:    String(statusFile.cores    || ''),
          ram:      String(statusFile.ram      || ''),
          disk:     String(statusFile.disk     || ''),
          os:       String(statusFile.os       || ''),
          address:  String(statusFile.address  || ''),
          username: String(statusFile.username || ''),
          password: String(statusFile.password || ''),
          aliveLine: timeStr ? `[${timeStr}] alive — RDP: ${statusFile.address} | restarting in ${minLeft} min` : ''
        },
        recentLines: [`[rdp-status.json] Last updated: ${statusFile.updatedAt} | Restarting in ${minLeft} min`],
        _debug: debug
      });
    }

    // ── 2. log archive ZIP ────────────────────────────────────
    let output = '';
    try { output = await fetchArchiveText(parsedRepo.owner, parsedRepo.repo, runId, token, debug); }
    catch (e) { if (e.statusCode === 401 || e.statusCode === 403) throw e; }

    // ── 3. per-job log text ───────────────────────────────────
    if (!output.trim()) {
      try { output = await fetchJobLogsText(parsedRepo.owner, parsedRepo.repo, runId, token, debug); }
      catch (e) { if (e.statusCode === 401 || e.statusCode === 403) throw e; }
    }

    if (!output.trim()) {
      return sendJson(res, 200, {
        repository: parsedRepo.slug, runId,
        details: {}, recentLines: [],
        message: 'Workflow is starting up — rdp-status.json not yet written. Wait ~2 min after "Maintain Session" step begins, then click Update Log.',
        _debug: debug
      });
    }

    const parsed = parseRunnerLogs(output);
    sendJson(res, 200, { repository: parsedRepo.slug, runId, ...parsed, _debug: debug });

  } catch (err) {
    sendApiError(res, err);
  }
};
