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
  constructor(root, bundled) { this.root = root; this.bundled = bundled; this.queue = Promise.resolve(); }
  exclusive(fn) { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  get exe() { return path.join(this.root, 'nginx.exe'); }
  async init() {
    await fs.mkdir(this.root, {recursive:true});
    // Never overwrite user configuration during application upgrades.
    await fs.copyFile(path.join(this.bundled, 'nginx.exe'), this.exe).catch(async e => { if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e; await fs.access(this.exe); });
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
  async files() { return ['nginx.conf', ...(await fs.readdir(path.join(this.root,'conf/sites'))).filter(n=>/^[a-zA-Z0-9_-]+\.conf$/.test(n)).map(n=>'sites/'+n)]; }
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
    return {running:stdout.trim().toLowerCase() === this.exe.toLowerCase(), pid};
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
  async backups() { return (await fs.readdir(path.join(this.root,'backups'))).filter(n=>/^\d+-(nginx\.conf|sites__[a-zA-Z0-9_-]+\.conf)\.bak$/.test(n)).sort().reverse(); }
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
module.exports = {Manager,siteConfig};
