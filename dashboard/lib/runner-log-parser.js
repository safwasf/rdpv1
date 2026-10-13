const MAX_RESPONSE_LOG_CHARS = 12000;

/**
 * Strip GitHub Actions timestamp prefix, ##[section] markers, and ANSI codes,
 * then trim whitespace from both ends.
 *
 * Raw line example:
 *   "2026-10-13T12:30:01.0000000Z   CPU      : INTEL(R) XEON(R)..."
 * After clean:
 *   "CPU      : INTEL(R) XEON(R)..."
 */
function cleanLine(raw) {
  return String(raw)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')           // ANSI escape codes
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z[ \t]*/,'') // GHA timestamp
    .replace(/^##\[[^\]]*\][ \t]*/, '')                 // ##[group] / ##[endgroup] etc.
    .trim();
}

/**
 * Scan all lines bottom-up (most recent first) and return the value
 * after "LabelPattern   : value".
 * Works even if there are leading spaces before the label.
 */
function findField(allText, labelPattern) {
  const re = new RegExp(`(?:^|[ \\t])${labelPattern}[ \\t]*:[ \\t]*(.+)$`, 'i');
  const lines = String(allText).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = cleanLine(lines[i]);
    const m = re.exec(line);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

/**
 * Parse raw combined log text into structured runner details.
 */
function parseRunnerLogs(text) {
  const all = String(text || '');

  // Detect alive lines: "[HH:MM:SS] alive — RDP: <ip> | restarting in N min"
  const aliveLines = all
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(line => /\balive\b.*\bRDP\s*:/i.test(line));
  const aliveLine = aliveLines.length ? aliveLines[aliveLines.length - 1] : '';

  // Address: prefer explicit label; fall back to alive-line IP
  let address = findField(all, 'Address');
  if (!address && aliveLine) {
    const m = aliveLine.match(/\bRDP\s*:\s*([^\s|,]+)/i);
    if (m) address = m[1];
  }

  const rawPassword = findField(all, 'Password');
  const password = rawPassword.slice(0, 512);

  // Sanitise log preview — hide password value
  let safe = all;
  if (rawPassword) safe = safe.split(rawPassword).join('[PASSWORD HIDDEN]');
  safe = safe.replace(/^.*\bpassword\s*:.*$/gim, '[Password hidden — use the Show button]');

  const safeLines = safe
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.trim());
  const recentLines = safeLines
    .slice(-60)
    .join('\n')
    .slice(-MAX_RESPONSE_LOG_CHARS)
    .split('\n');

  return {
    details: {
      cpu:      findField(all, 'CPU').slice(0, 1000),
      cores:    findField(all, 'Cores').slice(0, 1000),
      ram:      findField(all, 'RAM').slice(0, 1000),
      disk:     findField(all, 'Disk(?:[ \\t]*\\([Cc]:?\\))?').slice(0, 1000),
      os:       findField(all, 'OS').slice(0, 1000),
      address:  address.slice(0, 512),
      username: findField(all, 'Username').slice(0, 512),
      password,
      aliveLine: aliveLine.slice(0, 2000),
    },
    recentLines,
  };
}

module.exports = { parseRunnerLogs };
