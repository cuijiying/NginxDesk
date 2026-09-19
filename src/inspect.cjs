function parseNginxVersion(text) {
  const m = String(text || '').match(/nginx\/(\d+\.\d+\.\d+)/i);
  return m ? m[1] : '';
}

function parseNginxBuild(text) {
  const raw = String(text || '');
  const out = {version: parseNginxVersion(raw), prefix: '', exe: '', conf: '', pid: '', errorLog: '', accessLog: ''};
  const args = raw.match(/configure arguments:\s*(.*)$/im);
  if (!args) return out;
  const take = (name, key) => {
    const m = args[1].match(new RegExp(`--${name}=(\\S+)`));
    if (m) out[key] = m[1].replace(/^"|"$/g, '');
  };
  take('prefix', 'prefix');
  take('sbin-path', 'exe');
  take('conf-path', 'conf');
  take('pid-path', 'pid');
  take('error-log-path', 'errorLog');
  take('http-log-path', 'accessLog');
  return out;
}

function uncomment(content) {
  return String(content || '').replace(/#.*$/gm, '');
}

function parsePidDirective(content) {
  const matches = [...uncomment(content).matchAll(/\bpid\s+([^;]+);/g)].map(m => m[1].trim());
  return matches.length ? matches[0] : '';
}

function parseLogDirective(content, name) {
  const matches = [...uncomment(content).matchAll(new RegExp(`\\b${name}\\s+([^;]+);`, 'g'))];
  for (const m of matches) {
    const value = m[1].trim().split(/\s+/)[0].replace(/^"|"$/g, '');
    if (value && value !== 'off') return value;
  }
  return '';
}

function posixJoin(...parts) {
  const joined = parts.filter(Boolean).join('/').replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  return joined;
}

function resolveAgainst(root, value, posix) {
  const raw = String(value || '').trim().replaceAll('\\', '/');
  if (!raw) return '';
  const absolute = posix ? raw.startsWith('/') : /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(String(value || ''));
  if (absolute) return posix ? raw : String(value);
  return posix ? posixJoin(root, raw) : require('node:path').join(root, value);
}

function assertSafeHost(host) {
  const value = String(host || '').trim();
  if (!value || value.length > 253) throw Error('无效主机名');
  if (!/^[A-Za-z0-9.:_-]+$/.test(value) || value.includes('..')) throw Error('主机名含无效字符');
  return value;
}

function assertSafeUser(user) {
  const value = String(user || '').trim();
  if (!value || value.length > 64 || !/^[A-Za-z0-9._-]+$/.test(value)) throw Error('无效用户名');
  return value;
}

function assertSafePath(value, label = '路径') {
  const text = String(value || '').trim();
  if (!text || text.length > 512) throw Error(`无效${label}`);
  if (/[\0\r\n;|&$`]/.test(text) || text.includes('..')) throw Error(`${label}含无效字符`);
  return text;
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function parseNginxArgv(commandLine) {
  const text = String(commandLine || '');
  const take = flag => {
    const m = text.match(new RegExp(`(?:^|[\\s"])${flag}\\s+(?:"([^"]+)"|(\\S+))`, 'i'));
    return m ? String(m[1] || m[2] || '').replace(/[\\/]+$/, '') : '';
  };
  return {prefix: take('-p'), conf: take('-c')};
}

module.exports = {
  parseNginxVersion, parseNginxBuild, parsePidDirective, parseLogDirective, parseNginxArgv,
  posixJoin, resolveAgainst, assertSafeHost, assertSafeUser, assertSafePath, shQuote
};
