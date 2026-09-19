const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const {isWin, nginxBin, archiveExt, tarBin, execOpts} = require('../src/platform.cjs');

const version = '1.31.6';
const checksums = {
  zip: 'BB65EDCFC22A2214A4AFAAC59F038F560C02B98D4B49C5DCA1206D3CC5D631C9',
  'tar.gz': '974ED5298A5E398E008704ED5DB284E655FC270C596493DBCCADA452448FC9F1'
};

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function download(url, dest) {
  const res = await fetch(url, {redirect: 'follow', signal: AbortSignal.timeout(120000), headers: {'User-Agent': 'NginxDesk'}});
  if (!res.ok) throw Error(`下载失败：HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const vendor = path.join(root, 'vendor');
  const target = path.join(vendor, 'nginx');
  if (await exists(path.join(target, nginxBin))) {
    console.log(`vendor/nginx/${nginxBin} already present`);
    return;
  }
  await fs.mkdir(vendor, {recursive: true});
  const archiveName = `nginx-${version}.${archiveExt}`;
  const archive = path.join(vendor, archiveName);
  const expected = checksums[archiveExt];
  let buf;
  try { buf = await fs.readFile(archive); }
  catch { buf = await download(`https://nginx.org/download/${archiveName}`, archive); }
  const actual = sha256(buf);
  if (actual !== expected) throw Error(`nginx archive checksum mismatch\nexpected ${expected}\nactual   ${actual}`);
  const tmp = path.join(vendor, `nginx-${version}`);
  await fs.rm(tmp, {recursive: true, force: true});
  await run(tarBin, ['-xf', archive, '-C', vendor], execOpts({timeout: 60000}));
  if (isWin) {
    await fs.rm(target, {recursive: true, force: true});
    await fs.rename(tmp, target);
  } else {
    const {compileUnixNginx, copyUnixSupportFiles} = require('../src/unix-build.cjs');
    await fs.mkdir(target, {recursive: true});
    await compileUnixNginx(tmp, path.join(target, nginxBin));
    await copyUnixSupportFiles(tmp, target);
    await fs.rm(tmp, {recursive: true, force: true});
  }
  console.log(`prepared vendor/nginx/${nginxBin}`);
  console.log(`SHA256 ${archiveName}=${actual}`);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
