const JSZip = require('jszip');
const { parseRunnerLogs } = require('../lib/runner-log-parser');
const {
  sendJson, requirePost, requireDashboardKey,
  bearerToken, getBody, validateRepoSlug, githubJson, sendApiError
} = require('../lib/api-helpers');

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_TEXT_BYTES    =  8 * 1024 * 1024; //  8 MB

/* ── stream-safe body reader ─────────────────────────────────── */
async function readLimitedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) {
      const e = new Error('Log content is too large to process safely.'); e.statusCode = 413; throw e;
    }
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      const e = new Error('Log content is too large to process safely.'); e.statusCode = 413; throw e;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/* ── download full workflow archive (ZIP) ────────────────────── */
async function fetchArchiveText(owner, repo, runId, token) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/logs`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rdp-runner-dashboard'
    },
    redirect: 'follow',
    cache: 'no-store'
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      const msg = await response.text().catch(() => '');
      const e = new Error(msg || `GitHub returned ${response.status}`);
      e.statusCode = response.status; throw e;
    }
    // 404/410 = archive not ready for running job → caller falls through
    return '';
  }

  const declaredLen = Number(response.headers.get('content-length') || 0);
  if (declaredLen > MAX_ARCHIVE_BYTES) return ''; // too large; fall through

  const buf = await readLimitedBody(response, MAX_ARCHIVE_BYTES);
  const zip = await JSZip.loadAsync(buf, { checkCRC32: false, createFolders: false });

  // Read every non-directory .txt/.log file up to the text limit
  const files = Object.values(zip.files)
    .filter(f => !f.dir && /\.(txt|log)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  let output = '';
  let readBytes = 0;

  for (const file of files) {
    if (readBytes >= MAX_TEXT_BYTES) break;
    try {
      const content = await file.async('string');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (readBytes + bytes > MAX_TEXT_BYTES) continue;
      readBytes += bytes;
      output += `\n--- ${file.name} ---\n${content}\n`;
    } catch (_) { /* skip unreadable file */ }
  }
  return output;
}

/* ── fallback: individual job logs (available during active run) */
async function fetchJobLogsText(owner, repo, runId, token) {
  const jobsData = await githubJson(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs?per_page=100`,
    token
  );
  const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
  // Prefer the in-progress job — most likely to have current output
  jobs.sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'));

  const chunks = await Promise.all(jobs.slice(0, 20).map(async job => {
    if (!job || !Number.isSafeInteger(Number(job.id))) return '';
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${Number(job.id)}/logs`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'rdp-runner-dashboard'
          },
          redirect: 'follow',
          cache: 'no-store'
        }
      );
      if (!response.ok) return '';
      const text = (await readLimitedBody(response, MAX_TEXT_BYTES)).toString('utf8');
      return `\n--- JOB: ${job.name || job.id} (${job.status || ''}) ---\n${text}`;
    } catch (_) { return ''; }
  }));

  return chunks.join('\n').slice(0, MAX_TEXT_BYTES);
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

  try {
    let output = '';

    // 1️⃣ Try full archive (updated every 30s for running workflows)
    try {
      output = await fetchArchiveText(parsedRepo.owner, parsedRepo.repo, runId, token);
    } catch (archErr) {
      if (archErr.statusCode === 401 || archErr.statusCode === 403) throw archErr;
      // Any other error (network, ZIP parse) → fall through
    }

    // 2️⃣ Fallback: fetch per-job logs (available during active run)
    if (!output.trim()) {
      try {
        output = await fetchJobLogsText(parsedRepo.owner, parsedRepo.repo, runId, token);
      } catch (jobErr) {
        if (jobErr.statusCode === 401 || jobErr.statusCode === 403) throw jobErr;
        // Network / parse error → fall through
      }
    }

    // 3️⃣ Nothing available yet
    if (!output.trim()) {
      return sendJson(res, 200, {
        repository: parsedRepo.slug, runId,
        details: {}, recentLines: [],
        message: 'No readable logs available yet. GitHub updates logs every ~30s. Click Update Log again shortly.'
      });
    }

    const parsed = parseRunnerLogs(output);
    sendJson(res, 200, { repository: parsedRepo.slug, runId, ...parsed });

  } catch (err) {
    sendApiError(res, err);
  }
};
