const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const nginxBin = isWin ? 'nginx.exe' : 'nginx';
const archiveExt = isWin ? 'zip' : 'tar.gz';
const tarBin = isWin ? 'tar.exe' : 'tar';

function execOpts(extra = {}) {
  return {windowsHide: true, ...extra};
}

function platformLabel(platform = process.platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function userDataHint() {
  if (isWin) return '%APPDATA%/nginx-desk';
  if (isMac) return '~/Library/Application Support/nginx-desk';
  return '~/.config/nginx-desk';
}

function normalizeExe(file) {
  const resolved = path.resolve(String(file || ''));
  return isWin ? resolved.replaceAll('/', '\\').toLowerCase() : resolved;
}

function sameExecutable(got, mine) {
  if (!got || !mine) return false;
  const expected = normalizeExe(mine);
  const raw = String(got).trim().replace(/ \(deleted\)$/,'');
  if (!raw) return false;
  if (isWin) return normalizeExe(raw) === expected;
  if (raw === expected || raw === mine) return true;
  if (raw.startsWith(expected + ' ') || raw.startsWith(mine + ' ')) return true;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s:])${escaped}(?:$|[\\s])`).test(raw);
}

async function processExecutable(pid) {
  if (!Number.isInteger(pid) || pid < 1) return '';
  if (isWin) {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){$p.ExecutablePath}`;
    const {stdout} = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], execOpts({timeout: 10000}));
    return stdout.trim();
  }
  try { process.kill(pid, 0); } catch { return ''; }
  if (process.platform === 'linux') {
    try { return (await fs.readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, ''); }
    catch { return ''; }
  }
  try {
    const {stdout} = await run('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], execOpts({timeout: 8000}));
    const line = stdout.split(/\r?\n/).find(item => item.startsWith('n') && item.length > 1);
    if (line) return line.slice(1);
  } catch {}
  try {
    const {stdout} = await run('ps', ['-p', String(pid), '-ww', '-o', 'command='], execOpts({timeout: 8000}));
    return stdout.trim();
  } catch { return ''; }
}

function parseOfficialVersions(html, platform = process.platform) {
  if (typeof html !== 'string' || !html.trim()) throw Error('未能解析官方版本列表');
  const out = [];
  const seen = new Set();
  const take = (source, channel) => {
    const re = platform === 'win32'
      ? /nginx\/Windows-(\d+\.\d+\.\d+)/gi
      : /nginx-(\d+\.\d+\.\d+)\.tar\.gz(?![\w.])/gi;
    let m;
    while ((m = re.exec(source))) {
      const version = m[1];
      if (seen.has(version) || Number(version.split('.')[0]) < 1) continue;
      seen.add(version);
      out.push({version, channel});
    }
  };
  const parts = html.split(/<h4\b[^>]*>/i);
  for (const part of parts) {
    const title = (part.match(/^[^<]+/) || [''])[0].toLowerCase();
    const channel = title.includes('mainline') ? 'mainline' : title.includes('stable') ? 'stable' : title.includes('legacy') ? 'legacy' : '';
    if (channel) take(part, channel);
  }
  if (!out.length) take(html, 'release');
  if (!out.length) throw Error('未能解析官方版本列表');
  return out;
}

function parseWindowsVersions(html) {
  return parseOfficialVersions(html, 'win32');
}

module.exports = {
  isWin, isMac, nginxBin, archiveExt, tarBin,
  execOpts, platformLabel, userDataHint, normalizeExe, sameExecutable,
  processExecutable, parseOfficialVersions, parseWindowsVersions
};
