const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const {isWin, nginxBin, execOpts, normalizeExe, runningNginxProcesses} = require('./platform.cjs');
const {Manager} = require('./manager.cjs');
const {localIO, connectSsh} = require('./io.cjs');
const {
  parseNginxBuild, parsePidDirective, parseLogDirective, parseNginxArgv,
  assertSafeHost, assertSafeUser, assertSafePath, resolveAgainst
} = require('./inspect.cjs');

const MANAGED_ID = 'managed';

function assertName(name) {
  const text = String(name || '').trim();
  if (!text || text.length > 40) throw Error('名称长度应为 1–40 个字符');
  if (/[\r\n]/.test(text)) throw Error('名称不能包含换行');
  return text;
}

function assertPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw Error('端口应为 1–65535');
  return n;
}

function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    exe: item.exe || '',
    prefix: item.prefix || '',
    conf: item.conf || '',
    pid: item.pid || '',
    host: item.host || '',
    port: item.port || 22,
    username: item.username || '',
    auth: item.auth || '',
    keyPath: item.keyPath || '',
    sudo: !!item.sudo,
    hasSecret: !!item.hasSecret,
    needPassword: !!item.needPassword
  };
}

class Hub {
  constructor(userData, bundled, cryptoFns = {}) {
    this.userData = userData;
    this.bundled = bundled;
    this.encrypt = cryptoFns.encrypt;
    this.decrypt = cryptoFns.decrypt;
    this.canEncrypt = !!cryptoFns.encrypt;
    this.storePath = path.join(userData, 'connections.json');
    this.managed = new Manager(path.join(userData, 'runtime'), bundled, path.join(userData, 'engines'));
    this.current = this.managed;
    this.activeId = MANAGED_ID;
    this.items = [];
    this.memorySecrets = new Map();
    this.lastError = '';
  }
  managedItem() {
    return {id: MANAGED_ID, name: '本机托管实例', kind: 'managed', prefix: this.managed.root, exe: this.managed.exe, conf: 'conf/nginx.conf'};
  }
  async init() {
    await this.managed.init();
    await this.load();
    if (this.activeId && this.activeId !== MANAGED_ID) {
      try { await this.use(this.activeId); }
      catch (e) {
        this.lastError = e.message;
        this.current = this.managed;
        this.activeId = MANAGED_ID;
      }
    }
  }
  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
      this.items = Array.isArray(raw.items) ? raw.items.map(item => this.normalizeStored(item)).filter(Boolean) : [];
      this.activeId = typeof raw.activeId === 'string' && raw.activeId ? raw.activeId : MANAGED_ID;
    } catch { this.items = []; this.activeId = MANAGED_ID; }
  }
  normalizeStored(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.kind !== 'local' && item.kind !== 'remote') return null;
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(item.id)) return null;
    try {
      return {
        id: item.id,
        name: assertName(item.name),
        kind: item.kind,
        exe: assertSafePath(item.exe, 'nginx 路径'),
        prefix: assertSafePath(item.prefix, '工作目录'),
        conf: assertSafePath(item.conf, '配置路径'),
        pid: item.pid ? assertSafePath(item.pid, 'PID 路径') : '',
        host: item.kind === 'remote' ? assertSafeHost(item.host) : '',
        port: item.kind === 'remote' ? assertPort(item.port || 22) : 22,
        username: item.kind === 'remote' ? assertSafeUser(item.username) : '',
        auth: item.kind === 'remote' ? (item.auth === 'key' ? 'key' : 'password') : '',
        keyPath: item.keyPath ? assertSafePath(item.keyPath, '私钥路径') : '',
        sudo: !!(item.kind === 'remote' && item.sudo),
        secret: typeof item.secret === 'string' ? item.secret : '',
        passphrase: typeof item.passphrase === 'string' ? item.passphrase : '',
        hasSecret: !!(item.secret || item.hasSecret),
        needPassword: !!item.needPassword
      };
    } catch { return null; }
  }
  async persist() {
    const items = this.items.map(item => ({
      id: item.id, name: item.name, kind: item.kind, exe: item.exe, prefix: item.prefix, conf: item.conf,
      pid: item.pid, host: item.host, port: item.port, username: item.username, auth: item.auth,
      keyPath: item.keyPath, sudo: item.sudo, secret: item.secret || '', passphrase: item.passphrase || '',
      hasSecret: !!item.secret, needPassword: !!item.needPassword
    }));
    await fs.mkdir(this.userData, {recursive: true});
    await fs.writeFile(this.storePath, JSON.stringify({activeId: this.activeId, items}, null, 2));
  }
  list() {
    return {
      activeId: this.activeId,
      canEncrypt: this.canEncrypt,
      error: this.lastError,
      items: [this.managedItem(), ...this.items].map(item => publicItem(item))
    };
  }
  getItem(id) {
    if (id === MANAGED_ID) return this.managedItem();
    const item = this.items.find(row => row.id === id);
    if (!item) throw Error('连接不存在');
    return item;
  }
  backupDir(id) { return path.join(this.userData, 'connection-backups', id); }
  async discoverLocal() {
    const found = [];
    const seen = new Set();
    const hintsByExe = new Map();
    const addHint = (exe, hints = {}) => {
      const resolved = path.resolve(exe);
      const key = normalizeExe(resolved);
      const prev = hintsByExe.get(key) || {};
      hintsByExe.set(key, {
        exe: prev.exe || resolved,
        prefix: hints.prefix || prev.prefix || '',
        conf: hints.conf || prev.conf || ''
      });
    };
    const common = isWin
      ? ['C:\\nginx\\nginx.exe', 'C:\\Program Files\\nginx\\nginx.exe']
      : ['/usr/sbin/nginx', '/usr/bin/nginx', '/usr/local/sbin/nginx', '/usr/local/bin/nginx', '/opt/homebrew/opt/nginx/bin/nginx', '/opt/homebrew/bin/nginx'];
    const [pathHits, running] = await Promise.all([
      listPathNginx(),
      runningNginxProcesses().catch(() => [])
    ]);
    for (const proc of running) {
      if (!proc.exe) continue;
      addHint(proc.exe, parseNginxArgv(proc.commandLine));
    }
    for (const exe of [...pathHits, ...common]) addHint(exe);
    for (const candidate of hintsByExe.values()) {
      const key = normalizeExe(candidate.exe);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const item = await probeLocalInstall(candidate.exe, candidate, this.managed.exe);
        if (item) found.push(item);
      } catch {}
    }
    return found;
  }
  async probeDraft(draft) {
    const item = this.normalizeDraft(draft, {allowEmptySecret: true});
    const io = item.kind === 'remote' ? await this.openSsh(item, draft) : localIO;
    try {
      await io.access(item.exe);
      const build = parseNginxBuild(await io.exec(item.exe, ['-V'], {cwd: io.dirname(item.exe), timeout: 10000}));
      const prefix = item.prefix || build.prefix || io.dirname(item.exe);
      const conf = resolveAgainst(prefix, item.conf || build.conf || io.join(prefix, 'conf/nginx.conf'), io.posix);
      await io.access(conf);
      let pid = item.pid || build.pid || '';
      let errorLog = build.errorLog || '';
      let accessLog = build.accessLog || '';
      try {
        const content = await io.readFile(conf);
        pid = parsePidDirective(content) || pid;
        errorLog = parseLogDirective(content, 'error_log') || errorLog;
        accessLog = parseLogDirective(content, 'access_log') || accessLog;
      } catch {}
      const manager = new Manager(prefix, this.bundled, path.join(this.userData, 'engines'), {
        kind: item.kind, io, exe: item.exe, confPath: conf,
        pidPath: pid ? resolveAgainst(prefix, pid, io.posix) : '',
        logError: errorLog ? resolveAgainst(prefix, errorLog, io.posix) : '',
        logAccess: accessLog ? resolveAgainst(prefix, accessLog, io.posix) : '',
        backupRoot: this.backupDir(item.id || 'probe')
      });
      const status = await manager.status();
      return {
        version: build.version || await manager.probeVersion(),
        prefix, conf, pid: manager.pidFile(), exe: item.exe,
        running: !!status.running, pidNumber: status.pid || 0,
        errorLog: manager.errorLogFile(), accessLog: manager.accessLogFile()
      };
    } finally {
      if (io.remote) await io.close().catch(() => {});
    }
  }
  normalizeDraft(draft, {allowEmptySecret = false} = {}) {
    if (!draft || typeof draft !== 'object') throw Error('无效连接');
    const kind = draft.kind === 'remote' ? 'remote' : draft.kind === 'local' ? 'local' : '';
    if (!kind) throw Error('请选择本机已有或远程 SSH');
    const item = {
      id: typeof draft.id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(draft.id) ? draft.id : crypto.randomUUID(),
      name: assertName(draft.name),
      kind,
      exe: assertSafePath(draft.exe, 'nginx 路径'),
      prefix: assertSafePath(draft.prefix, '工作目录'),
      conf: assertSafePath(draft.conf, '配置路径'),
      pid: draft.pid ? assertSafePath(draft.pid, 'PID 路径') : '',
      host: '', port: 22, username: '', auth: '', keyPath: '', sudo: false,
      secret: '', passphrase: '', hasSecret: false, needPassword: false
    };
    if (kind === 'remote') {
      item.host = assertSafeHost(draft.host);
      item.port = assertPort(draft.port || 22);
      item.username = assertSafeUser(draft.username);
      item.auth = draft.auth === 'key' ? 'key' : 'password';
      item.keyPath = item.auth === 'key' ? assertSafePath(draft.keyPath || '', '私钥路径') : '';
      item.sudo = !!draft.sudo;
      const password = typeof draft.password === 'string' ? draft.password : '';
      const passphrase = typeof draft.passphrase === 'string' ? draft.passphrase : '';
      if (item.auth === 'password' && password) item._password = password;
      else if (item.auth === 'password' && !allowEmptySecret && !draft.id) throw Error('请填写 SSH 密码');
      if (item.auth === 'key' && passphrase) item._passphrase = passphrase;
    }
    return item;
  }
  encodeSecret(value) {
    if (!value) return '';
    if (!this.encrypt) return '';
    try { return this.encrypt(value); }
    catch { return ''; }
  }
  decodeSecret(blob) {
    if (!blob || !this.decrypt) return '';
    try { return this.decrypt(blob); }
    catch { return ''; }
  }
  async save(draft) {
    const incoming = this.normalizeDraft(draft, {allowEmptySecret: !!draft.id});
    if (incoming.kind === 'remote') {
      const existing = this.items.find(row => row.id === incoming.id);
      if (incoming._password) {
        const enc = this.encodeSecret(incoming._password);
        if (enc) { incoming.secret = enc; incoming.hasSecret = true; incoming.needPassword = false; }
        else { this.memorySecrets.set(incoming.id, {password: incoming._password}); incoming.needPassword = true; incoming.hasSecret = false; }
      } else if (existing) {
        incoming.secret = existing.secret;
        incoming.hasSecret = existing.hasSecret;
        incoming.needPassword = existing.needPassword;
      } else if (incoming.auth === 'password') incoming.needPassword = true;
      if (incoming._passphrase) {
        const enc = this.encodeSecret(incoming._passphrase);
        if (enc) incoming.passphrase = enc;
        else {
          const mem = this.memorySecrets.get(incoming.id) || {};
          mem.passphrase = incoming._passphrase;
          this.memorySecrets.set(incoming.id, mem);
        }
      } else if (existing) incoming.passphrase = existing.passphrase;
    }
    delete incoming._password;
    delete incoming._passphrase;
    const probed = await this.probeDraft({...incoming, password: draft.password, passphrase: draft.passphrase});
    incoming.exe = probed.exe;
    incoming.prefix = probed.prefix;
    incoming.conf = probed.conf;
    incoming.pid = probed.pid;
    const index = this.items.findIndex(row => row.id === incoming.id);
    if (index >= 0) this.items[index] = incoming;
    else this.items.push(incoming);
    await this.persist();
    return publicItem(incoming);
  }
  async remove(id) {
    if (id === MANAGED_ID) throw Error('不能删除本机托管实例');
    const index = this.items.findIndex(row => row.id === id);
    if (index < 0) throw Error('连接不存在');
    if (this.activeId === id) await this.use(MANAGED_ID);
    this.items.splice(index, 1);
    this.memorySecrets.delete(id);
    await this.persist();
    await fs.rm(this.backupDir(id), {recursive: true, force: true}).catch(() => {});
    return this.list();
  }
  async unlock(id, password) {
    const item = this.getItem(id);
    if (item.kind !== 'remote') throw Error('只有远程连接需要解锁');
    if (typeof password !== 'string' || !password) throw Error('请输入 SSH 密码');
    this.memorySecrets.set(id, {...(this.memorySecrets.get(id) || {}), password});
    return this.use(id);
  }
  async credentials(item, draft = {}) {
    if (item.kind !== 'remote') return {};
    let password = typeof draft.password === 'string' && draft.password ? draft.password : '';
    let passphrase = typeof draft.passphrase === 'string' && draft.passphrase ? draft.passphrase : '';
    const mem = this.memorySecrets.get(item.id) || {};
    if (!password) password = mem.password || this.decodeSecret(item.secret);
    if (!passphrase) passphrase = mem.passphrase || this.decodeSecret(item.passphrase);
    let privateKey = '';
    if (item.auth === 'key') {
      if (!item.keyPath) throw Error('请选择 SSH 私钥文件');
      privateKey = await fs.readFile(item.keyPath, 'utf8');
    }
    if (item.auth === 'password' && !password) throw Error('请输入 SSH 密码');
    return {password, privateKey, passphrase};
  }
  async openSsh(item, draft = {}) {
    const creds = await this.credentials(item, draft);
    try {
      return await connectSsh({
        host: item.host, port: item.port, username: item.username,
        password: creds.password, privateKey: creds.privateKey, passphrase: creds.passphrase, sudo: item.sudo
      });
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/All configured authentication methods failed|authentication/i.test(msg)) throw Error('SSH 认证失败，请检查用户名、密码或私钥');
      if (/Timed out|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg)) throw Error('无法连接到 SSH 主机，请检查地址、端口和网络');
      throw Error(msg || 'SSH 连接失败');
    }
  }
  async detach() {
    if (this.current && this.current !== this.managed) await this.current.io.close().catch(() => {});
    this.current = this.managed;
    this.activeId = MANAGED_ID;
  }
  async use(id) {
    if (id === MANAGED_ID) {
      await this.detach();
      await this.persist();
      this.lastError = '';
      return this.snapshot();
    }
    const item = this.getItem(id);
    const io = item.kind === 'remote' ? await this.openSsh(item) : localIO;
    const posix = item.kind === 'remote';
    const manager = new Manager(item.prefix, this.bundled, path.join(this.userData, 'engines'), {
      kind: item.kind, io, exe: item.exe,
      confPath: resolveAgainst(item.prefix, item.conf, posix),
      pidPath: item.pid ? resolveAgainst(item.prefix, item.pid, posix) : '',
      backupRoot: this.backupDir(item.id)
    });
    try { await manager.init(); }
    catch (e) {
      if (io.remote) await io.close().catch(() => {});
      throw e;
    }
    await this.detach();
    this.current = manager;
    this.activeId = item.id;
    await this.persist();
    this.lastError = '';
    return this.snapshot();
  }
  connectionMeta() {
    const item = this.activeId === MANAGED_ID ? this.managedItem() : this.getItem(this.activeId);
    return {
      id: item.id, name: item.name, kind: item.kind,
      host: item.host || '', username: item.username || '',
      remote: this.current.io && this.current.io.remote,
      engines: item.kind === 'managed',
      folder: item.kind !== 'remote'
    };
  }
  async snapshot() {
    const manager = this.current;
    const [status, files, version] = await Promise.all([manager.status(), manager.files(), manager.currentVersion()]);
    return {
      ...status, files, root: manager.root, platform: process.platform,
      version: version ? `nginx version: nginx/${version}` : 'nginx',
      connection: this.connectionMeta()
    };
  }
}

async function listPathNginx() {
  try {
    const {stdout} = await run(
      isWin ? 'where.exe' : '/bin/sh',
      isWin ? [nginxBin] : ['-c', 'command -v nginx'],
      execOpts({timeout: 8000})
    );
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch { return []; }
}

async function existingDir(dir) {
  if (!dir) return '';
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory() ? dir : '';
  } catch { return ''; }
}

async function existingFile(file) {
  if (!file) return '';
  try {
    await fs.access(file);
    return file;
  } catch { return ''; }
}

async function probeLocalInstall(exe, hints = {}, skipExe = '') {
  const resolved = path.resolve(exe);
  if (skipExe && normalizeExe(resolved) === normalizeExe(skipExe)) return null;
  await fs.access(resolved);
  const home = path.dirname(resolved);
  const text = await localIO.exec(resolved, ['-V'], {cwd: home, timeout: 8000});
  const build = parseNginxBuild(text);
  const prefix = await existingDir(hints.prefix)
    || await existingDir(build.prefix)
    || home;
  const conf = await existingFile(hints.conf && path.isAbsolute(hints.conf) ? hints.conf : '')
    || await existingFile(build.conf && path.isAbsolute(build.conf) ? build.conf : '')
    || await existingFile(resolveAgainst(prefix, hints.conf || build.conf || path.join('conf', 'nginx.conf'), false))
    || await existingFile(path.join(home, 'conf', 'nginx.conf'))
    || resolveAgainst(prefix, 'conf/nginx.conf', false);
  return {
    exe: resolved,
    version: build.version,
    prefix,
    conf,
    pid: build.pid || '',
    errorLog: build.errorLog || '',
    accessLog: build.accessLog || ''
  };
}

module.exports = {Hub, MANAGED_ID, probeLocalInstall};
