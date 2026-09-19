const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);

function fail(error, fallback) {
  const detail = String((error && (error.stderr || error.stdout || error.message)) || fallback || '');
  throw Error(`编译 nginx 失败。macOS 请安装 Xcode Command Line Tools；Linux 请安装 gcc、make，以及 pcre/zlib/openssl 开发库。\n${detail}`.trim());
}

async function compileUnixNginx(srcDir, destExe) {
  const configure = path.join(srcDir, 'configure');
  await fs.access(configure);
  await fs.chmod(configure, 0o755).catch(() => {});
  const jobs = String(Math.max(1, os.cpus().length || 1));
  const attempts = [
    ['--prefix=/tmp/nginx-desk', '--with-http_ssl_module', '--with-http_v2_module', '--with-http_realip_module', '--with-http_stub_status_module'],
    ['--prefix=/tmp/nginx-desk', '--with-http_v2_module', '--with-http_realip_module', '--with-http_stub_status_module'],
    ['--prefix=/tmp/nginx-desk', '--without-http_rewrite_module', '--with-http_v2_module', '--with-http_realip_module'],
    ['--prefix=/tmp/nginx-desk', '--without-http_rewrite_module', '--without-http_gzip_module', '--without-http_ssl_module']
  ];
  let last;
  for (const args of attempts) {
    try {
      await run('/bin/sh', [configure, ...args], {cwd: srcDir, timeout: 180000, maxBuffer: 2 * 1024 * 1024});
      last = null;
      break;
    } catch (error) { last = error; }
  }
  if (last) fail(last);
  try {
    await run('make', ['-j', jobs], {cwd: srcDir, timeout: 600000, maxBuffer: 4 * 1024 * 1024});
  } catch (error) { fail(error); }
  const built = path.join(srcDir, 'objs', 'nginx');
  await fs.access(built).catch(() => fail(null, '编译完成但未找到 objs/nginx'));
  await fs.mkdir(path.dirname(destExe), {recursive: true});
  await fs.copyFile(built, destExe);
  await fs.chmod(destExe, 0o755);
}

async function copyUnixSupportFiles(srcDir, destDir) {
  await fs.mkdir(path.join(destDir, 'conf'), {recursive: true});
  await fs.mkdir(path.join(destDir, 'docs'), {recursive: true});
  await fs.mkdir(path.join(destDir, 'html'), {recursive: true});
  for (const name of ['mime.types', 'fastcgi_params', 'scgi_params', 'uwsgi_params', 'koi-utf', 'koi-win', 'win-utf']) {
    await fs.copyFile(path.join(srcDir, 'conf', name), path.join(destDir, 'conf', name)).catch(() => {});
  }
  for (const name of ['docs/text/LICENSE', 'LICENSE', 'docs/LICENSE']) {
    try {
      await fs.copyFile(path.join(srcDir, name), path.join(destDir, 'docs', 'LICENSE'));
      break;
    } catch {}
  }
}

module.exports = {compileUnixNginx, copyUnixSupportFiles};
