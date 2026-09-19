const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const {execOpts, processExecutable} = require('./platform.cjs');
const {posixJoin, shQuote, assertSafePath} = require('./inspect.cjs');

class LocalIO {
  constructor() { this.remote = false; this.posix = process.platform !== 'win32'; }
  join(root, rel) { return path.join(root, rel); }
  dirname(file) { return path.dirname(file); }
  slash(file) { return String(file).replaceAll('\\', '/'); }
  async access(file) { await fs.access(file); }
  async mkdir(dir) { await fs.mkdir(dir, {recursive: true}); }
  async readdir(dir) {
    try { return await fs.readdir(dir); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async readFile(file) { return fs.readFile(file, 'utf8'); }
  async writeFile(file, content) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, content); }
  async unlink(file) { await fs.unlink(file); }
  async readTail(file, max = 65536) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const {size} = await handle.stat();
      const buf = Buffer.alloc(Math.min(size, max));
      await handle.read(buf, 0, buf.length, Math.max(0, size - buf.length));
      return buf.toString('utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return '暂无日志';
      throw e;
    } finally { await handle?.close(); }
  }
  async exec(file, args, opts = {}) {
    try {
      const r = await run(file, args, execOpts({cwd: opts.cwd, timeout: opts.timeout || 15000, maxBuffer: 1024 * 1024}));
      return `${r.stdout || ''}${r.stderr || ''}`;
    } catch (e) { throw Error(e.stderr || e.message); }
  }
  async start(file, args, cwd) {
    const child = spawn(file, args, {cwd, windowsHide: true, detached: true, stdio: 'ignore'});
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
  processExecutable(pid) { return processExecutable(pid); }
  async close() {}
}

function sftpErr(e) {
  if (e && (e.code === 2 || e.code === 'ENOENT')) { const err = Error(e.message || 'ENOENT'); err.code = 'ENOENT'; throw err; }
  throw e;
}

function sftpRead(sftp, file, start) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(file, start == null ? {} : {start});
    stream.on('data', d => chunks.push(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

class SshIO {
  constructor(client, sftp, {sudo = false} = {}) {
    this.remote = true; this.posix = true; this.client = client; this.sftp = sftp; this.sudo = !!sudo;
  }
  join(root, rel) { return posixJoin(root, rel); }
  dirname(file) {
    const norm = String(file).replaceAll('\\', '/').replace(/\/+$/, '');
    const i = norm.lastIndexOf('/');
    return i <= 0 ? '/' : norm.slice(0, i);
  }
  slash(file) { return String(file).replaceAll('\\', '/'); }
  async access(file) {
    await new Promise((resolve, reject) => this.sftp.stat(file, (e, s) => e ? reject(e) : resolve(s))).catch(sftpErr);
  }
  async mkdir(dir) {
    const parts = this.slash(dir).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      await new Promise((resolve, reject) => {
        this.sftp.mkdir(cur, e => {
          if (!e || e.code === 4 || e.code === 11) return resolve();
          this.sftp.stat(cur, se => se ? reject(e) : resolve());
        });
      });
    }
  }
  async readdir(dir) {
    try {
      const list = await new Promise((resolve, reject) => this.sftp.readdir(dir, (e, v) => e ? reject(e) : resolve(v)));
      return list.map(item => item.filename);
    } catch (e) {
      if (e && e.code === 2) return [];
      throw e;
    }
  }
  async readFile(file) { return (await sftpRead(this.sftp, file).catch(sftpErr)).toString('utf8'); }
  async writeFile(file, content) {
    await this.mkdir(this.dirname(file));
    await new Promise((resolve, reject) => {
      const stream = this.sftp.createWriteStream(file);
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.end(Buffer.from(content));
    });
  }
  async unlink(file) {
    await new Promise((resolve, reject) => this.sftp.unlink(file, e => e ? reject(e) : resolve())).catch(sftpErr);
  }
  async readTail(file, max = 65536) {
    try {
      const stat = await new Promise((resolve, reject) => this.sftp.stat(file, (e, s) => e ? reject(e) : resolve(s)));
      const start = Math.max(0, Number(stat.size || 0) - max);
      return (await sftpRead(this.sftp, file, start)).toString('utf8');
    } catch (e) {
      if (e && (e.code === 2 || e.code === 'ENOENT')) return '暂无日志';
      throw e;
    }
  }
  execCommand(file, args) {
    assertSafePath(file, '可执行文件');
    const line = [file, ...args].map(shQuote).join(' ');
    return this.sudo ? `sudo -n ${line}` : line;
  }
  async exec(file, args, opts = {}) {
    const command = this.execCommand(file, args);
    const {stdout, stderr, code} = await sshExec(this.client, command, opts.timeout || 15000);
    if (code) throw Error(stderr || stdout || `远程命令失败（${code}）`);
    return `${stdout}${stderr}`;
  }
  async start(file, args) { await this.exec(file, args); }
  async processExecutable(pid) {
    if (!Number.isInteger(pid) || pid < 1) return '';
    try {
      const {stdout, stderr} = await sshExec(this.client, `readlink /proc/${pid}/exe || ps -p ${pid} -ww -o args=`, 8000);
      return String(stdout || stderr || '').trim().split(/\r?\n/)[0] || '';
    } catch { return ''; }
  }
  async close() {
    try { this.sftp.end(); } catch {}
    try { this.client.end(); } catch {}
  }
}

function sshExec(client, command, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('远程命令超时')), timeout);
    client.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      let stdout = '', stderr = '';
      stream.on('data', d => { stdout += d; });
      stream.stderr.on('data', d => { stderr += d; });
      stream.on('close', (code) => { clearTimeout(timer); resolve({stdout, stderr, code: code || 0}); });
      stream.on('error', e => { clearTimeout(timer); reject(e); });
    });
  });
}

async function connectSsh({host, port, username, password, privateKey, passphrase, sudo}) {
  let Client;
  try { ({Client} = require('ssh2')); }
  catch { throw Error('未安装远程连接组件。请在项目目录执行 npm install 后重试'); }
  const client = new Client();
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.connect({
      host, port: port || 22, username,
      password: password || undefined,
      privateKey: privateKey || undefined,
      passphrase: passphrase || undefined,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      tryKeyboard: false
    });
  });
  const sftp = await promisify(client.sftp.bind(client))();
  return new SshIO(client, sftp, {sudo});
}

module.exports = {LocalIO, SshIO, connectSsh, localIO: new LocalIO()};
