const JSZip = require('jszip');
const { parseRunnerLogs } = require('../lib/runner-log-parser');
const { sendJson, requirePost, requireDashboardKey, bearerToken, getBody, validateRepoSlug, githubJson, sendApiError } = require('../lib/api-helpers');

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

async function readLimitedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      const error = new Error('Workflow log content is too large to process safely.');
      error.statusCode = 413;
      throw error;
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      const error = new Error('Workflow log content is too large to process safely.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function fetchJobLogsFallback(owner, repo, runId, token) {
  const jobsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs?per_page=100`;
  const jobsData = await githubJson(jobsUrl, token);
  const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];

  // Prefer the running job so an in-progress step has the best chance of appearing.
  jobs.sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'));
  const selected = jobs.slice(0, 20);

  const chunks = await Promise.all(selected.map(async job => {
    if (!job || !Number.isSafeInteger(Number(job.id))) return '';
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${Number(job.id)}/logs`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'actions-running-runners-dashboard'
          },
          redirect: 'follow',
          cache: 'no-store'
        }
      );
      if (!response.ok) return '';
      const text = (await readLimitedBody(response, MAX_TEXT_BYTES)).toString('utf8');
      return `\n--- JOB ${job.name || job.id} (${job.status || 'unknown'}) ---\n${text}`;
    } catch (_) { return ''; }
  }));

  return chunks.join('\n').slice(0, MAX_TEXT_BYTES);
}

module.exports = async function runLog(req, res) {
  if (!requirePost(req, res)) return;
  if (!requireDashboardKey(req, res)) return;

  const token = bearerToken(req);
  if (!token) return sendJson(res, 401, { message: 'A GitHub token is required. Add it in Tokens & Repos.' });

  const body = getBody(req) || {};
  const parsedRepo = validateRepoSlug(body.repo);
  const runId = Number(body.runId);
  if (!parsedRepo) return sendJson(res, 400, { message: 'Repository must be in owner/repo format.' });
  if (!Number.isSafeInteger(runId) || runId <= 0) return sendJson(res, 400, { message: 'A valid numeric workflow run ID is required.' });

  try {
    const archiveUrl = `https://api.github.com/repos/${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.repo)}/actions/runs/${runId}/logs`;

    let output = '';
    let fatalError = null;

    // ── Attempt 1: full workflow log archive (ZIP) ───────────────
    try {
      const response = await fetch(archiveUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'actions-running-runners-dashboard'
        },
        redirect: 'follow',
        cache: 'no-store'
      });

      if (response.ok) {
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > MAX_ARCHIVE_BYTES) {
          return sendJson(res, 413, { message: 'Workflow log archive is too large to process safely in this function.' });
        }
        const archiveBuffer = await readLimitedBody(response, MAX_ARCHIVE_BYTES);
        try {
          const zip = await JSZip.loadAsync(archiveBuffer, { checkCRC32: false, createFolders: false });
          const files = Object.values(zip.files)
            .filter(f => !f.dir && /\.(txt|log)$/i.test(f.name))
            .sort((a, b) => a.name.localeCompare(b.name));
          let readBytes = 0;
          for (const file of files) {
            const size = Number(file._data && file._data.uncompressedSize) || 0;
            if (!size || size > MAX_TEXT_BYTES - readBytes) continue;
            const content = await file.async('string');
            const bytes = Buffer.byteLength(content, 'utf8');
            if (bytes > MAX_TEXT_BYTES - readBytes) continue;
            readBytes += bytes;
            output += `\n--- ${file.name} ---\n${content}\n`;
          }
        } catch (zipError) {
          // ZIP parse failure — fall through to job-log fallback
        }
      } else if (response.status === 401 || response.status === 403) {
        // Auth failures are fatal — no point trying the fallback
        let message = `GitHub log download failed (HTTP ${response.status}).`;
        try { const err = await response.json(); if (typeof err.message === 'string') message = err.message; } catch (_) {}
        fatalError = new Error(message);
        fatalError.statusCode = response.status;
      }
      // 404 / 410 = archive not ready yet for a running job; silently fall through.
    } catch (archiveFetchError) {
      // Network error on archive fetch — fall through to job-log fallback
    }

    if (fatalError) throw fatalError;

    // ── Attempt 2: individual job logs (available during active runs) ──
    if (!output.trim()) {
      try {
        output = await fetchJobLogsFallback(parsedRepo.owner, parsedRepo.repo, runId, token);
      } catch (fallbackError) {
        // If both attempts failed with auth errors, surface it
        if (fallbackError.statusCode === 401 || fallbackError.statusCode === 403) {
          throw fallbackError;
        }
        // Otherwise just continue — logs aren't available yet
      }
    }

    // ── No logs available yet ────────────────────────────────────
    if (!output.trim()) {
      return sendJson(res, 200, {
        repository: parsedRepo.slug,
        runId,
        details: {},
        recentLines: [],
        message: 'GitHub has not made readable logs available for this run yet. Click Update Log again after more output is emitted.'
      });
    }

    // ── Parse and return ─────────────────────────────────────────
    const parsed = parseRunnerLogs(output);
    sendJson(res, 200, { repository: parsedRepo.slug, runId, ...parsed });

  } catch (error) {
    sendApiError(res, error);
  }
};
