const { sendJson, requirePost, requireDashboardKey, bearerToken, getBody, validateRepoSlug, githubJson, sendApiError } = require('../lib/api-helpers');

module.exports = async function runningRuns(req, res) {
  if (!requirePost(req, res)) return;
  if (!requireDashboardKey(req, res)) return;
  const token = bearerToken(req);
  if (!token) return sendJson(res, 401, { message: 'A GitHub token is required. Add it in Tokens & Repos.' });
  const body = getBody(req) || {};
  const parsedRepo = validateRepoSlug(body.repo);
  if (!parsedRepo) return sendJson(res, 400, { message: 'Repository must be in owner/repo format.' });

  try {
    const base = `https://api.github.com/repos/${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.repo)}/actions/runs`;
    const first = await githubJson(`${base}?status=in_progress&per_page=100&page=1`, token);
    const total = Math.max(0, Number(first.total_count) || 0);
    const runs = Array.isArray(first.workflow_runs) ? first.workflow_runs : [];
    const maxPages = 20; // Up to 2,000 active runs per repo; bounded to protect serverless execution time.
    const pages = Math.min(maxPages, Math.ceil(total / 100));
    if (pages > 1) {
      const others = await Promise.all(Array.from({ length: pages - 1 }, (_, idx) =>
        githubJson(`${base}?status=in_progress&per_page=100&page=${idx + 2}`, token)
      ));
      for (const page of others) if (Array.isArray(page.workflow_runs)) runs.push(...page.workflow_runs);
    }
    const unique = new Map();
    for (const run of runs) {
      if (run && run.status === 'in_progress' && run.id != null) unique.set(String(run.id), run);
    }
    sendJson(res, 200, { repository: parsedRepo.slug, totalCount: total, truncated: total > maxPages * 100, runs: Array.from(unique.values()) });
  } catch (error) {
    sendApiError(res, error);
  }
};
