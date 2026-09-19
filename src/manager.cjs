const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const delay = ms => new Promise(r => setTimeout(r, ms));

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
function parseNginxVersion(text) {
  const m = String(text || '').match(/nginx\/(\d+\.\d+\.\d+)/i);
  return m ? m[1] : '';
}
function networkError(e, fallback) {
  const name = e && e.name || '';
  const msg = String((e && e.message) || e || '');
  if (name === 'TimeoutError' || /aborted|timeout/i.test(msg)) throw Error('网络超时，请检查连接后重试');
  throw Error(fallback || msg || '网络请求失败');
}

function parseWindowsVersions(html) {
  if (typeof html !== 'string' || !html.trim()) throw Error('未能解析官方版本列表');
  const out = [];
  const seen = new Set();
  const take = (source, channel) => {
    const re = /nginx\/Windows-(\d+\.\d+\.\d+)/gi;
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

class Manager {
  constructor(root, bundled, enginesRoot) {
    this.root = root; this.bundled = bundled; this.enginesRoot = enginesRoot || path.join(root, 'engines');
    this.queue = Promise.resolve(); this._version = ''; this._official = null; this._officialAt = 0;
  }
  exclusive(fn) { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  get exe() { return path.join(this.root, 'nginx.exe'); }
  engineExe(version) { return path.join(this.enginesRoot, assertVersion(version), 'nginx.exe'); }
  async probeVersion(exe = this.exe) {
    try { const r = await run(exe, ['-v'], {cwd:path.dirname(exe), windowsHide:true, timeout:10000}); return parseNginxVersion(`${r.stdout}${r.stderr}`); }
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
      const list = parseWindowsVersions(await res.text());
      this._official = list; this._officialAt = Date.now();
      return list;
    } catch (e) {
      if (e instanceof Error && /^(未能解析|获取官方)/.test(e.message)) throw e;
      networkError(e, '获取官方版本列表失败');
    }
  }
  async versions(refresh=false) {
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
    return {current, installed, available, error};
  }
  async downloadEngine(version) {
    version = assertVersion(version);
    await fs.mkdir(this.enginesRoot, {recursive:true});
    const zip = path.join(this.enginesRoot, `nginx-${version}.zip`);
    let haveZip = false;
    try {
      const buf = await fs.readFile(zip);
      haveZip = buf.length >= 1000 && buf[0] === 0x50 && buf[1] === 0x4b;
    } catch {}
    if (!haveZip) {
      try {
        const res = await fetch(`https://nginx.org/download/nginx-${version}.zip`, {redirect:'follow', signal:AbortSignal.timeout(120000), headers:{'User-Agent':'NginxDesk'}});
        if (!res.ok) throw Error(`下载失败：HTTP ${res.status}`);
        const declared = Number(res.headers.get('content-length') || 0);
        if (declared > 40 * 1024 * 1024) throw Error('安装包过大');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1000 || buf.length > 40 * 1024 * 1024) throw Error('安装包大小异常');
        if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw Error('安装包不是有效的 zip 文件');
        await fs.writeFile(zip, buf);
      } catch (e) {
        if (e instanceof Error && /^(下载失败|安装包)/.test(e.message)) throw e;
        networkError(e, '下载失败');
      }
    }
    const tmp = await fs.mkdtemp(path.join(this.enginesRoot, 'extract-'));
    try {
      await run('tar.exe', ['-xf', zip, '-C', tmp], {windowsHide:true, timeout:60000});
      const exe = path.resolve(tmp, `nginx-${version}`, 'nginx.exe');
      const rel = path.relative(path.resolve(tmp), exe);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('安装包结构异常');
      await fs.access(exe);
      await fs.mkdir(path.dirname(this.engineExe(version)), {recursive:true});
      await fs.copyFile(exe, this.engineExe(version));
      await fs.unlink(zip).catch(()=>{});
    } finally {
      await fs.rm(tmp, {recursive:true, force:true});
    }
  }
  async installVersion(version) { return this.exclusive(async () => {
    version = assertVersion(version);
    if ((await this.status()).running) throw Error('请先停止 nginx，再安装或切换版本');
    try { await fs.access(this.engineExe(version)); }
    catch {
      const official = await this.fetchOfficialVersions();
      if (!official.some(item => item.version === version)) throw Error('该版本不在官方 Windows 发行列表中');
      await this.downloadEngine(version);
    }
    await fs.copyFile(this.engineExe(version), this.exe);
    this._version = '';
    const current = await this.probeVersion() || parseNginxVersion(await this.command(['-v']).catch(()=>''));
    if (current !== version) throw Error(`版本切换异常，当前为 ${current || '未知'}`);
    await fs.writeFile(path.join(this.enginesRoot, 'active'), version);
    this._version = current;
    return `已启用 nginx ${version}`;
  }); }
  async deleteVersion(version) { return this.exclusive(async () => {
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
    await fs.mkdir(this.root, {recursive:true});
    await fs.mkdir(this.enginesRoot, {recursive:true});
    const bundledExe = path.join(this.bundled, 'nginx.exe');
    const bundledVer = await this.probeVersion(bundledExe);
    if (bundledVer) {
      await fs.mkdir(path.dirname(this.engineExe(bundledVer)), {recursive:true});
      await fs.copyFile(bundledExe, this.engineExe(bundledVer), 1).catch(e => { if (e.code !== 'EEXIST') throw e; });
    }
    const pinned = await this.pinnedVersion();
    const source = pinned ? this.engineExe(pinned) : bundledExe;
    // Keep a user-pinned engine across app upgrades; otherwise refresh the bundled binary.
    await fs.copyFile(source, this.exe).catch(async e => { if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e; await fs.access(this.exe); });
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
  file(name) {
    if (typeof name !== 'string' || !(name === 'nginx.conf' || /^sites\/[a-zA-Z0-9_-]+\.conf$/.test(name))) throw Error('无效配置文件名');
    return path.join(this.root, 'conf', name);
  }
  async files() {
    const dir = path.join(this.root,'conf/sites');
    await fs.mkdir(dir,{recursive:true});
    return ['nginx.conf', ...(await fs.readdir(dir)).filter(n=>/^[a-zA-Z0-9_-]+\.conf$/.test(n)).map(n=>'sites/'+n)];
  }
  async read(name) { return fs.readFile(this.file(name), 'utf8'); }
  async command(args) {
    try { const r = await run(this.exe, ['-p', this.root.replaceAll('\\','/')+'/', '-c', 'conf/nginx.conf', ...args], {cwd:this.root, windowsHide:true, timeout:15000, maxBuffer:1024*1024}); return r.stdout+r.stderr; }
    catch(e) { throw Error(e.stderr || e.message); }
  }
  async status() {
    let pid;
    try { pid = Number((await fs.readFile(path.join(this.root,'logs/nginx.pid'),'utf8')).trim()); } catch { return {running:false}; }
    if (!Number.isInteger(pid) || pid < 1) return {running:false};
    // Check the executable path as well as PID; never control another nginx installation.
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){$p.ExecutablePath}`;
    const {stdout} = await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {windowsHide:true,timeout:10000});
    const got = stdout.trim().replaceAll('/','\\').toLowerCase();
    const mine = this.exe.replaceAll('/','\\').toLowerCase();
    return {running: got === mine, pid};
  }
  async action(action) { return this.exclusive(async () => {
    const s = await this.status();
    if (action === 'test') return this.command(['-t']);
    if (!['start','quit','reload','reopen'].includes(action)) throw Error('未知操作');
    if (action === 'start') {
      if (s.running) return 'nginx 已在运行';
      await this.command(['-t']);
      const child = spawn(this.exe, ['-p',this.root.replaceAll('\\','/')+'/', '-c','conf/nginx.conf'], {cwd:this.root,windowsHide:true,detached:true,stdio:'ignore'});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve); child.once('error',reject);}); child.unref();
      for (let i=0;i<10;i++) { await delay(300); if ((await this.status()).running) return 'nginx 启动成功'; }
      throw Error('启动失败，请查看错误日志（可能存在端口冲突）');
    }
    if (!s.running) throw Error('当前托管的 nginx 未运行');
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
    // Fixed PID location is necessary for safe process ownership checks.
    if (name === 'nginx.conf') {
      const clean = content.replace(/#.*$/gm,'');
      const pids = [...clean.matchAll(/\bpid\s+([^;]+);/g)];
      if (pids.length !== 1 || pids[0][1].trim() !== 'logs/nginx.pid') throw Error('请保留唯一的 pid logs/nginx.pid; 指令');
    }
    let previous = null;
    try { previous = await fs.readFile(file,'utf8'); } catch(e) { if(e.code!=='ENOENT')throw e; }
    let backup;
    if(previous !== null) { backup = `${Date.now()}-${name.replaceAll('/','__')}.bak`; await fs.writeFile(path.join(this.root,'backups',backup), previous); }
    try { await fs.writeFile(file,content); await this.command(['-t']); }
    catch(e) { if(previous===null)await fs.unlink(file).catch(()=>{}); else await fs.writeFile(file,previous); throw Error(`保存未生效，已回滚：\n${e.message}`); }
    return '配置校验通过并已保存；运行中的 nginx 需点击「重载配置」后生效。';
  }); }
  async backups() {
    const dir = path.join(this.root,'backups');
    await fs.mkdir(dir,{recursive:true});
    return (await fs.readdir(dir)).filter(n=>/^\d+-(nginx\.conf|sites__[a-zA-Z0-9_-]+\.conf)\.bak$/.test(n)).sort().reverse();
  }
  async backup(name) {
    if(!(await this.backups()).includes(name))throw Error('备份不存在');
    return {file:name.replace(/^\d+-/,'').replace(/\.bak$/,'').replace('__','/'),content:await fs.readFile(path.join(this.root,'backups',name),'utf8')};
  }
  async logs(type) {
    if(!['error','access'].includes(type))throw Error('无效日志类型');
    let handle;
    try { handle=await fs.open(path.join(this.root,`logs/${type}.log`),'r'); const {size}=await handle.stat(); const b=Buffer.alloc(Math.min(size,65536)); await handle.read(b,0,b.length,Math.max(0,size-b.length)); return b.toString('utf8'); }
    catch(e){if(e.code==='ENOENT')return '暂无日志';throw e;}finally{await handle?.close();}
  }
}
module.exports = {Manager,siteConfig,assertVersion,parseNginxVersion,parseWindowsVersions};
