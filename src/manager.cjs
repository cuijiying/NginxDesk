const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const delay = ms => new Promise(r => setTimeout(r, ms));
const {
  isWin, nginxBin, archiveExt, tarBin, execOpts,
  sameExecutable, parseOfficialVersions, parseWindowsVersions
} = require('./platform.cjs');
const {parseNginxVersion, parsePidDirective, parseLogDirective} = require('./inspect.cjs');
const {localIO} = require('./io.cjs');

const initialConfig = `worker_processes 1;
pid logs/nginx.pid;
error_log logs/error.log;
events { worker_connections 1024; }
http {
    include mime.types;
    default_type application/octet-stream;
    access_log logs/access.log;
    sendfile on;
    keepalive_timeout 65;
    include sites/*.conf;
}
`;
const defaultSite = `server {
    listen 127.0.0.1:8080;
    server_name localhost;
    location / {
        root html;
        index index.html;
    }
}
`;

function assertVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw Error('无效的 nginx 版本号');
  return version;
}
function networkError(e, fallback) {
  const name = e && e.name || '';
  const msg = String((e && e.message) || e || '');
  if (name === 'TimeoutError' || /aborted|timeout/i.test(msg)) throw Error('网络超时，请检查连接后重试');
  throw Error(fallback || msg || '网络请求失败');
}

async function markExecutable(file) {
  if (!isWin) await fs.chmod(file, 0o755).catch(() => {});
}

function siteConfig({port, host, kind, target}) {
  if (!/^\d+$/.test(String(port)) || +port < 1 || +port > 65535) throw Error('端口应为 1–65535');
  if (!/^[a-zA-Z0-9.*_-]+$/.test(host)) throw Error('域名只允许字母、数字、点、星号、下划线和连字符');
  if (typeof target !== 'string' || !target.trim() || /[\r\n";{}$]/.test(target)) throw Error('目标路径或地址含无效字符');
  let body;
  if (kind === 'proxy') {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /\s/.test(target)) throw Error('请输入有效的 HTTP/HTTPS 上游地址');
    body = `proxy_pass ${target};\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;`;
  } else if (kind === 'static') {
    body = `root "${target.replaceAll('\\', '/')}";\n        index index.html;\n        try_files $uri $uri/ =404;`;
  } else throw Error('未知站点类型');
  return `server {\n    listen ${port};\n    server_name ${host};\n    location / {\n        ${body}\n    }\n}\n`;
}

function attachedConfName(name) {
  return name === 'nginx.conf'
    || /^(sites|conf\.d|sites-available)\/[a-zA-Z0-9_-]+\.conf$/.test(name)
    || /^sites-enabled\/[a-zA-Z0-9_.-]+$/.test(name);
}

function resolveTargetPath(io, root, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(?:\/|[a-zA-Z]:)/.test(text)) return text;
  return io.join(root, text);
}

class Manager {
  constructor(root, bundled, enginesRoot, options = {}) {
    this.root = root; this.bundled = bundled; this.enginesRoot = enginesRoot || path.join(root, 'engines');
    this.kind = options.kind || 'managed';
    this.io = options.io || localIO;
    this.exePath = options.exe || '';
    this.confPath = options.confPath || '';
    this.pidPath = options.pidPath || '';
    this.logError = options.logError || '';
    this.logAccess = options.logAccess || '';
    this.backupRoot = options.backupRoot || path.join(root, 'backups');
    this.queue = Promise.resolve(); this._version = ''; this._official = null; this._officialAt = 0;
  }
  exclusive(fn) { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  get managed() { return this.kind === 'managed'; }
  get exe() { return this.exePath || path.join(this.root, nginxBin); }
  confFile() { return this.confPath || this.io.join(this.root, 'conf/nginx.conf'); }
  pidFile() { return this.pidPath || this.io.join(this.root, 'logs/nginx.pid'); }
  errorLogFile() { return this.logError || this.io.join(this.root, 'logs/error.log'); }
  accessLogFile() { return this.logAccess || this.io.join(this.root, 'logs/access.log'); }
  nginxArgs(extra = []) {
    const prefix = this.io.slash(this.root).replace(/\/?$/, '/');
    const conf = this.managed ? 'conf/nginx.conf' : this.io.slash(this.confFile());
    return ['-p', prefix, '-c', conf, ...extra];
  }
  engineExe(version) { return path.join(this.enginesRoot, assertVersion(version), nginxBin); }
  async probeVersion(exe = this.exe) {
    try { return parseNginxVersion(await this.io.exec(exe, ['-v'], {cwd: this.io.dirname(exe), timeout: 10000})); }
    catch { return ''; }
  }
  async currentVersion(force=false) {
    if (!force && this._version) return this._version;
    const v = await this.probeVersion() || parseNginxVersion(await this.command(['-v']).catch(()=>''));
    this._version = v;
    return v;
  }
  async pinnedVersion() {
    try {
      const version = assertVersion((await fs.readFile(path.join(this.enginesRoot, 'active'), 'utf8')).trim());
      await fs.access(this.engineExe(version));
      return version;
    } catch { return ''; }
  }
  async installedEngines() {
    try {
      const names = await fs.readdir(this.enginesRoot);
      const out = [];
      for (const name of names) {
        if (!/^\d+\.\d+\.\d+$/.test(name)) continue;
        try { await fs.access(this.engineExe(name)); out.push(name); } catch {}
      }
      return out.sort((a,b) => b.localeCompare(a, undefined, {numeric:true}));
    } catch { return []; }
  }
  async fetchOfficialVersions(refresh=false) {
    if (!refresh && this._official && Date.now() - this._officialAt < 10 * 60 * 1000) return this._official;
    try {
      const res = await fetch('https://nginx.org/en/download.html', {redirect:'follow', signal:AbortSignal.timeout(20000), headers:{'User-Agent':'NginxDesk'}});
      if (!res.ok) throw Error(`获取官方版本列表失败：HTTP ${res.status}`);
      const list = parseOfficialVersions(await res.text());
      this._official = list; this._officialAt = Date.now();
      return list;
    } catch (e) {
      if (e instanceof Error && /^(未能解析|获取官方)/.test(e.message)) throw e;
      networkError(e, '获取官方版本列表失败');
    }
  }
  async versions(refresh=false) {
    if (!this.managed) {
      const current = await this.currentVersion() || '';
      return {current, installed: current ? [current] : [], available: current ? [{version:current, channel:'local'}] : [], error: '仅本机托管实例支持安装或切换引擎版本', platform: process.platform};
    }
    const installed = await this.installedEngines();
    const current = await this.currentVersion() || installed[0] || '';
    let available = [], error = null;
    try { available = await this.fetchOfficialVersions(!!refresh); }
    catch (e) {
      error = e.message;
      available = installed.map(version => ({version, channel:'local'}));
    }
    const seen = new Set(available.map(item => item.version));
    for (const version of installed) if (!seen.has(version)) available.push({version, channel:'local'});
    return {current, installed, available, error, platform: process.platform};
  }
  async downloadEngine(version) {
    version = assertVersion(version);
    await fs.mkdir(this.enginesRoot, {recursive:true});
    const archive = path.join(this.enginesRoot, `nginx-${version}.${archiveExt}`);
    let haveArchive = false;
    try {
      const buf = await fs.readFile(archive);
      haveArchive = buf.length >= 1000 && (isWin ? buf[0] === 0x50 && buf[1] === 0x4b : buf[0] === 0x1f && buf[1] === 0x8b);
    } catch {}
    if (!haveArchive) {
      try {
        const res = await fetch(`https://nginx.org/download/nginx-${version}.${archiveExt}`, {redirect:'follow', signal:AbortSignal.timeout(120000), headers:{'User-Agent':'NginxDesk'}});
        if (!res.ok) throw Error(`下载失败：HTTP ${res.status}`);
        const declared = Number(res.headers.get('content-length') || 0);
        if (declared > 40 * 1024 * 1024) throw Error('安装包过大');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1000 || buf.length > 40 * 1024 * 1024) throw Error('安装包大小异常');
        if (isWin && (buf[0] !== 0x50 || buf[1] !== 0x4b)) throw Error('安装包不是有效的 zip 文件');
        if (!isWin && (buf[0] !== 0x1f || buf[1] !== 0x8b)) throw Error('安装包不是有效的 tar.gz 文件');
        await fs.writeFile(archive, buf);
      } catch (e) {
        if (e instanceof Error && /^(下载失败|安装包)/.test(e.message)) throw e;
        networkError(e, '下载失败');
      }
    }
    const tmp = await fs.mkdtemp(path.join(this.enginesRoot, 'extract-'));
    try {
      await run(tarBin, ['-xf', archive, '-C', tmp], execOpts({timeout: 60000}));
      const unpacked = path.resolve(tmp, `nginx-${version}`);
      const rel = path.relative(path.resolve(tmp), unpacked);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('安装包结构异常');
      await fs.mkdir(path.dirname(this.engineExe(version)), {recursive:true});
      if (isWin) {
        const exe = path.join(unpacked, 'nginx.exe');
        await fs.access(exe);
        await fs.copyFile(exe, this.engineExe(version));
      } else {
        const {compileUnixNginx} = require('./unix-build.cjs');
        await compileUnixNginx(unpacked, this.engineExe(version));
      }
      await markExecutable(this.engineExe(version));
      await fs.unlink(archive).catch(()=>{});
    } finally {
      await fs.rm(tmp, {recursive:true, force:true});
    }
  }
  async installVersion(version) { return this.exclusive(async () => {
    if (!this.managed) throw Error('附加的已有实例不支持切换引擎，请在目标环境自行更换 nginx');
    version = assertVersion(version);
    if ((await this.status()).running) throw Error('请先停止 nginx，再安装或切换版本');
    try { await fs.access(this.engineExe(version)); }
    catch {
      const official = await this.fetchOfficialVersions();
      if (!official.some(item => item.version === version)) throw Error('该版本不在官方发行列表中');
      await this.downloadEngine(version);
    }
    await fs.copyFile(this.engineExe(version), this.exe);
    await markExecutable(this.exe);
    this._version = '';
    const current = await this.probeVersion() || parseNginxVersion(await this.command(['-v']).catch(()=>''));
    if (current !== version) throw Error(`版本切换异常，当前为 ${current || '未知'}`);
    await fs.writeFile(path.join(this.enginesRoot, 'active'), version);
    this._version = current;
    return `已启用 nginx ${version}`;
  }); }
  async deleteVersion(version) { return this.exclusive(async () => {
    if (!this.managed) throw Error('附加的已有实例不支持删除引擎缓存');
    version = assertVersion(version);
    try { await fs.access(this.engineExe(version)); }
    catch { throw Error('该版本未下载，无需删除'); }
    const current = await this.currentVersion() || await this.probeVersion();
    const pinned = await this.pinnedVersion();
    if (version === current || version === pinned) throw Error('不能删除当前正在使用的版本，请先启用其他版本');
    await fs.rm(path.join(this.enginesRoot, version), {recursive:true, force:true});
    return `已删除 nginx ${version} 的本地缓存`;
  }); }
  async init() {
    if (!this.managed) {
      await this.io.access(this.exe);
      await this.io.access(this.confFile());
      await fs.mkdir(this.backupRoot, {recursive:true});
      await this.refreshLogPaths();
      this._version = await this.probeVersion();
      return;
    }
    await fs.mkdir(this.root, {recursive:true});
    await fs.mkdir(this.enginesRoot, {recursive:true});
    const bundledExe = path.join(this.bundled, nginxBin);
    const bundledVer = await this.probeVersion(bundledExe);
    if (bundledVer) {
      await fs.mkdir(path.dirname(this.engineExe(bundledVer)), {recursive:true});
      await fs.copyFile(bundledExe, this.engineExe(bundledVer), 1).catch(e => { if (e.code !== 'EEXIST') throw e; });
      await markExecutable(this.engineExe(bundledVer));
    }
    const pinned = await this.pinnedVersion();
    const source = pinned ? this.engineExe(pinned) : bundledExe;
    // Keep a user-pinned engine across app upgrades; otherwise refresh the bundled binary.
    await fs.copyFile(source, this.exe).catch(async e => { if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e; await fs.access(this.exe); });
    await markExecutable(this.exe);
    this._version = pinned || bundledVer || await this.probeVersion();
    // Never overwrite user configuration during application upgrades.
    for (const name of ['conf', 'conf/sites', 'logs', 'backups', 'html', 'temp']) await fs.mkdir(path.join(this.root, name), {recursive:true});
    for (const name of ['mime.types', 'fastcgi_params', 'scgi_params', 'uwsgi_params']) {
      await fs.copyFile(path.join(this.bundled, 'conf', name), path.join(this.root, 'conf', name), 1).catch(e => { if (e.code !== 'EEXIST') throw e; });
    }
    try { await fs.access(path.join(this.root, 'conf/nginx.conf')); }
    catch {
      await fs.writeFile(path.join(this.root, 'conf/sites/default.conf'), defaultSite);
      await fs.writeFile(path.join(this.root, 'html/index.html'), '<!doctype html><meta charset="utf-8"><title>Nginx Desk</title><h1>Nginx Desk is running.</h1>');
      await fs.writeFile(path.join(this.root, 'conf/nginx.conf'), initialConfig);
    }
  }
  async refreshLogPaths() {
    if (this.managed) return;
    try {
      const content = await this.io.readFile(this.confFile());
      const pid = parsePidDirective(content);
      if (pid && !this.pidPath) this.pidPath = resolveTargetPath(this.io, this.root, pid);
      const errorLog = parseLogDirective(content, 'error_log');
      const accessLog = parseLogDirective(content, 'access_log');
      if (errorLog && !this.logError) this.logError = resolveTargetPath(this.io, this.root, errorLog);
      if (accessLog && !this.logAccess) this.logAccess = resolveTargetPath(this.io, this.root, accessLog);
    } catch {}
  }
  file(name) {
    if (this.managed) {
      if (typeof name !== 'string' || !(name === 'nginx.conf' || /^sites\/[a-zA-Z0-9_-]+\.conf$/.test(name))) throw Error('无效配置文件名');
      return path.join(this.root, 'conf', name);
    }
    if (typeof name !== 'string' || !attachedConfName(name)) throw Error('无效配置文件名');
    if (name === 'nginx.conf') return this.confFile();
    return this.io.join(this.io.dirname(this.confFile()), name);
  }
  async files() {
    if (this.managed) {
      const dir = path.join(this.root,'conf/sites');
      await fs.mkdir(dir,{recursive:true});
      return ['nginx.conf', ...(await fs.readdir(dir)).filter(n=>/^[a-zA-Z0-9_-]+\.conf$/.test(n)).map(n=>'sites/'+n)];
    }
    const dir = this.io.dirname(this.confFile());
    const out = ['nginx.conf'];
    for (const [folder, re, prefix] of [
      ['sites', /^[a-zA-Z0-9_-]+\.conf$/, 'sites/'],
      ['conf.d', /^[a-zA-Z0-9_-]+\.conf$/, 'conf.d/'],
      ['sites-enabled', /^[a-zA-Z0-9_.-]+$/, 'sites-enabled/'],
      ['sites-available', /^[a-zA-Z0-9_-]+\.conf$/, 'sites-available/']
    ]) {
      const names = await this.io.readdir(this.io.join(dir, folder));
      for (const n of names) if (re.test(n) && attachedConfName(prefix + n)) out.push(prefix + n);
    }
    return out;
  }
  async read(name) { return this.io.readFile(this.file(name)); }
  async command(args) {
    return this.io.exec(this.exe, this.nginxArgs(args), {cwd: this.root, timeout: 15000});
  }
  async status() {
    let pid;
    try { pid = Number((await this.io.readFile(this.pidFile())).trim()); } catch { return {running:false}; }
    if (!Number.isInteger(pid) || pid < 1) return {running:false};
    const got = await this.io.processExecutable(pid);
    return {running: sameExecutable(got, this.exe), pid};
  }
  async action(action) { return this.exclusive(async () => {
    const s = await this.status();
    if (action === 'test') return this.command(['-t']);
    if (!['start','quit','reload','reopen'].includes(action)) throw Error('未知操作');
    if (action === 'start') {
      if (s.running) return 'nginx 已在运行';
      await this.command(['-t']);
      await this.io.start(this.exe, this.nginxArgs([]), this.root);
      for (let i=0;i<10;i++) { await delay(300); if ((await this.status()).running) return 'nginx 启动成功'; }
      throw Error('启动失败，请查看错误日志（可能存在端口冲突）');
    }
    if (!s.running) throw Error('当前 nginx 未运行');
    if (action === 'reload') await this.command(['-t']);
    const output = await this.command(['-s',action]);
    if (action === 'quit') {
      for(let i=0;i<10;i++){await delay(300);if(!(await this.status()).running)return 'nginx 已停止';}
      return '已发送优雅停止信号，正在等待连接结束';
    }
    return output || '操作成功';
  }); }
  async save(name, content) { return this.exclusive(async()=> {
    const file = this.file(name);
    if (typeof content !== 'string' || Buffer.byteLength(content)>1024*1024) throw Error('配置大小不能超过 1 MB');
    if (this.managed && name === 'nginx.conf') {
      const clean = content.replace(/#.*$/gm,'');
      const pids = [...clean.matchAll(/\bpid\s+([^;]+);/g)];
      if (pids.length !== 1 || pids[0][1].trim() !== 'logs/nginx.pid') throw Error('请保留唯一的 pid logs/nginx.pid; 指令');
    }
    let previous = null;
    try { previous = await this.io.readFile(file); } catch(e) { if(e.code!=='ENOENT')throw e; }
    if(previous !== null) {
      await fs.mkdir(this.backupRoot, {recursive:true});
      const backup = `${Date.now()}-${name.replaceAll('/','__')}.bak`;
      await fs.writeFile(path.join(this.backupRoot,backup), previous);
    }
    try { await this.io.writeFile(file,content); await this.command(['-t']); }
    catch(e) { if(previous===null)await this.io.unlink(file).catch(()=>{}); else await this.io.writeFile(file,previous); throw Error(`保存未生效，已回滚：\n${e.message}`); }
    if (name === 'nginx.conf') await this.refreshLogPaths();
    return '配置校验通过并已保存；运行中的 nginx 需点击「重载配置」后生效。';
  }); }
  async backups() {
    await fs.mkdir(this.backupRoot,{recursive:true});
    const re = this.managed
      ? /^\d+-(nginx\.conf|sites__[a-zA-Z0-9_-]+\.conf)\.bak$/
      : /^\d+-(nginx\.conf|sites__[a-zA-Z0-9_-]+\.conf|conf\.d__[a-zA-Z0-9_-]+\.conf|sites-enabled__[a-zA-Z0-9_.-]+|sites-available__[a-zA-Z0-9_-]+\.conf)\.bak$/;
    return (await fs.readdir(this.backupRoot)).filter(n=>re.test(n)).sort().reverse();
  }
  async backup(name) {
    if(!(await this.backups()).includes(name))throw Error('备份不存在');
    return {file:name.replace(/^\d+-/,'').replace(/\.bak$/,'').replace('__','/'),content:await fs.readFile(path.join(this.backupRoot,name),'utf8')};
  }
  async logs(type) {
    if(!['error','access'].includes(type))throw Error('无效日志类型');
    return this.io.readTail(type === 'error' ? this.errorLogFile() : this.accessLogFile());
  }
}
module.exports = {Manager,siteConfig,assertVersion,parseNginxVersion,parseWindowsVersions,parseOfficialVersions,attachedConfName};
