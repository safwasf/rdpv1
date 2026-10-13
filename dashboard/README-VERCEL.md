# GitHub Actions + Tailscale Dashboard — Vercel Edition

This package keeps the original dashboard (GitHub Actions controls, Tokens & Repos, Tailscale Machines) and adds a **Running Runners** view with one card for every active `in_progress` workflow run across all configured repositories.

## Deploy to Vercel

1. Upload this folder to a private GitHub repository, or import the ZIP contents into a new repository.
2. In Vercel, choose **Add New → Project**, import the repository, and use the project root (no build command required).
3. Before deploying, open **Project → Settings → Environment Variables** and add:
   - Name: `DASHBOARD_ACCESS_KEY`
   - Value: a long, random secret (at least 32 characters). Do not use an example value or a password used elsewhere.
   - Enable it for Production (and Preview only if you intentionally want the preview to work).
4. Deploy or redeploy after saving the environment variable.
5. Open the deployed site → **Tokens & Repos**. Add a GitHub token with access to the repositories and the **Actions: Read** permission, then add every repository you want to monitor. The token is stored in that browser's localStorage; it is not built into the Vercel deployment.
6. Open **Views → Running Runners**, paste the same `DASHBOARD_ACCESS_KEY` value from Vercel, and click **Load Running Runs**.
7. Optional: open **Tailscale Machines** and enter your Tailscale API token. The Vercel proxy now uses the same dashboard access key as an additional gate.

## Running Runners view

- Checks all saved repository configurations, and lists all run records currently returned by GitHub with status `in_progress` (up to 2,000 active run records per repository per refresh; higher counts are marked as truncated in the UI).
- Downloads each active workflow's log archive through `/api/run-log`, extracts runner specs (CPU, cores, RAM, disk, OS), RDP Address/Username/Password, and the latest `alive — RDP:` line.
- Passwords are hidden by default. Use **Show/Hide**, **Copy**, **Copy Full Info**, or **Copy All Runner Info**. Recent raw log preview redacts password lines and occurrences of the extracted password.
- Run lists poll at the dashboard's configured refresh interval (15 seconds by default); log archives refresh at most every 30 seconds automatically, or immediately using **Update Log** / **Refresh Now**. GitHub does not guarantee a downloadable log archive at every instant: the serverless route also tries individual job logs, but the newest output may not appear until GitHub flushes it. This is polling, not a push stream.
- If GitHub Actions masks a password as `***`, the app cannot recover the original value from the log archive. The workflow must explicitly output that value (which is not recommended for production credentials) or provide a separate secure secret mechanism.

## Security notes — important

- This view can display live RDP credentials parsed from workflow logs. Do not deploy it publicly without a strong `DASHBOARD_ACCESS_KEY`, and do not share the key. Prefer Vercel deployment protection / private access controls as an additional layer.
- Use a fine-grained GitHub token restricted to the required repositories, with **Actions: Read**. Existing Start/Stop/Re-run dashboard controls need additional write permissions when used.
- GitHub tokens entered in the browser remain in that browser's localStorage. Never use the dashboard on an untrusted/shared device; remove tokens and revoke them if exposed.
- The access key is held only in sessionStorage in the browser tab/session. Forget it before leaving a shared computer.
- The Vercel API does not store GitHub or Tailscale tokens and does not log Authorization headers or downloaded signed log URLs. API responses use `Cache-Control: no-store`.
- Workflow logs may include other sensitive values besides the RDP password. Keep the repository, deployment, and access key private. Use GitHub masking / secure secret workflows where possible.

## Files

- `index.html` — existing full dashboard plus Running Runners cards
- `api/running-runs.js` — all active runs in configured repos
- `api/run-log.js` — extracts runner session details from workflow log archives
- `api/tailscale.js` — same-origin Tailscale API proxy for Vercel
- `lib/api-helpers.js` — auth, validation, and response helpers
- `lib/runner-log-parser.js` — parser with password-redacted preview
- `package.json` — JSZip dependency for workflow log archives

## Troubleshooting

- **DASHBOARD_CONFIG / HTTP 503:** ensure `DASHBOARD_ACCESS_KEY` exists in Vercel Environment Variables, is at least 20 characters, and redeploy.
- **DASHBOARD_AUTH / HTTP 401:** paste exactly the same access key in Running Runners.
- **GitHub 403:** the saved token needs repository access and Actions read permission. Check rate limits if many repositories are configured.
- **Not found in logs:** the active run may not have printed that label, GitHub may not have flushed live output yet, or GitHub could have masked the value. Click Update Log after output appears.
- **Logs too large:** this function currently bounds the compressed archive to 20 MiB and text extraction to 8 MiB to avoid resource exhaustion.
