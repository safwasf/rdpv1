const MAX_RESPONSE_LOG_CHARS = 12000;

// Strip GitHub Actions timestamp prefix (e.g. "2026-10-13T12:37:06.0000000Z ") and ANSI codes.
function cleanLine(raw) {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')   // ANSI escape codes
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, '') // GHA timestamp
    .replace(/^##\[[^\]]*\]\s*/, '')             // GHA section markers like ##[group]
    .trim();
}

// Scan lines bottom-up and return the capture group value for the first match.
function pickLine(text, labelRegex) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = cleanLine(lines[i]);
    const match = labelRegex.exec(line);
    if (match && match[1]) return match[1].trim();
  }
  return '';
}

// Match a labelled field: "  Label    : value" or "Label : value" etc.
// The label is at or near the start of the cleaned line, followed by optional spaces then colon.
function findField(text, labelPattern) {
  // (?:^|\s) so label can follow leading whitespace (already trimmed by cleanLine)
  const re = new RegExp(`(?:^|(?<=\\s))${labelPattern}\\s*:\\s*(.+)$`, 'i');
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = cleanLine(lines[i]);
    const match = re.exec(line);
    if (match && match[1]) return match[1].trim();
  }
  return '';
}

// Simpler version without lookbehind for environments that don't support it.
function findFieldSafe(text, labelPattern) {
  const re = new RegExp(`(?:^|\\s)${labelPattern}\\s*:\\s*(.+)$`, 'i');
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = cleanLine(lines[i]);
    const match = re.exec(line);
    if (match && match[1]) {
      // If captured group has leading space (from the \s match), strip it.
      return match[1].trim();
    }
  }
  return '';
}

function parseRunnerLogs(text) {
  const all = String(text || '');

  // Try lookbehind first; fall back to the safe version if the engine doesn't support it.
  let find;
  try {
    ''.match(new RegExp('(?<=\\s)x'));
    find = (label) => findField(all, label);
  } catch (_) {
    find = (label) => findFieldSafe(all, label);
  }

  // Alive line: "[HH:MM:SS] alive — RDP: <ip> | restarting in N min"
  const aliveLines = all.split(/\r?\n/).map(cleanLine).filter(line =>
    /\balive\b.*\bRDP\s*:/i.test(line)
  );
  const aliveLine = aliveLines.length ? aliveLines[aliveLines.length - 1] : '';

  // Address: prefer explicit "Address : <ip>" label; fall back to alive line.
  let address = find('Address');
  if (!address && aliveLine) {
    const m = aliveLine.match(/\bRDP\s*:\s*([^\s|,]+)/i);
    if (m) address = m[1];
  }

  // Password
  const rawPassword = find('Password');
  const password = rawPassword.slice(0, 512);

  // Mask password in the preview log.
  let safe = all;
  if (rawPassword) safe = safe.split(rawPassword).join('[PASSWORD HIDDEN]');
  safe = safe.replace(/^.*\bpassword\s*:.*$/gim, '[Password hidden — use the Show button]');

  const safeLines = safe.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim());
  const recentLines = safeLines.slice(-60).join('\n').slice(-MAX_RESPONSE_LOG_CHARS).split('\n');

  return {
    details: {
      cpu:      find('CPU').slice(0, 1000),
      cores:    find('Cores').slice(0, 1000),
      ram:      find('RAM').slice(0, 1000),
      // Matches "Disk (C)" or "Disk (C:)" or just "Disk"
      disk:     find('Disk(?:\\s*\\([Cc]:?\\))?').slice(0, 1000),
      os:       find('OS').slice(0, 1000),
      address:  String(address || '').slice(0, 512),
      username: find('Username').slice(0, 512),
      password,
      aliveLine: String(aliveLine || '').slice(0, 2000)
    },
    recentLines
  };
}

module.exports = { parseRunnerLogs };
