const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const fsSync=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const http=require('node:http');
const {Manager,siteConfig,assertVersion,parseNginxVersion,parseWindowsVersions,parseOfficialVersions}=require('../src/manager.cjs');
const {nginxBin,sameExecutable}=require('../src/platform.cjs');
const hasBundled=fsSync.existsSync(path.resolve('vendor/nginx',nginxBin));
test('reject injection and invalid ports',()=>{
  for(const port of [0,65536,'80;'])assert.throws(()=>siteConfig({port,host:'localhost',kind:'proxy',target:'http://localhost'}));
  assert.throws(()=>siteConfig({port:8080,host:'x;}',kind:'static',target:'C:/www'}));
  assert.throws(()=>siteConfig({port:8080,host:'localhost',kind:'static',target:'C:/www";'}));
  const m=new Manager('C:/tmp','');assert.throws(()=>m.file('../secrets'));assert.throws(()=>m.file('sites/../../secrets'));
});
test('parse official Windows version list and reject unsafe versions',()=>{
  for(const version of ['', '1.2', '1.2.3.4', '1.31.6a', '../1.31.6', '1.31.6/../../evil', 'http://x', '1.31.6\n1.0.0'])assert.throws(()=>assertVersion(version));
  assert.equal(assertVersion('1.31.6'),'1.31.6');
  assert.equal(parseNginxVersion('nginx version: nginx/1.31.6'),'1.31.6');
  const html=`<h4>Mainline version</h4><a href="/download/nginx-1.31.6.zip">nginx/Windows-1.31.6</a> pgp
<h4>Stable version</h4><a href="/download/nginx-1.30.5.zip">nginx/Windows-1.30.5</a>
<h4>Legacy versions</h4><a href="/download/nginx-1.28.3.zip">nginx/Windows-1.28.3</a>
<a href="/download/nginx-0.8.55.zip">nginx/Windows-0.8.55</a>
<a href="/download/nginx-1.31.6.tar.gz">nginx-1.31.6</a>`;
  assert.deepEqual(parseWindowsVersions(html),[
    {version:'1.31.6',channel:'mainline'},
    {version:'1.30.5',channel:'stable'},
    {version:'1.28.3',channel:'legacy'}
  ]);
  assert.throws(()=>parseWindowsVersions('<html>no versions</html>'));
  const unixHtml=`<h4>Mainline version</h4><a href="/download/nginx-1.31.6.tar.gz">nginx-1.31.6</a> pgp
<a href="/download/nginx-1.31.6.zip">nginx/Windows-1.31.6</a>
<h4>Stable version</h4><a href="/download/nginx-1.30.5.tar.gz">nginx-1.30.5</a>
<h4>Legacy versions</h4><a href="/download/nginx-1.28.3.tar.gz">nginx-1.28.3</a>
<a href="/download/nginx-0.8.55.tar.gz">nginx-0.8.55</a>
<a href="/download/nginx-1.31.6.tar.gz.asc">sig</a>`;
  assert.deepEqual(parseOfficialVersions(unixHtml,'linux'),[
    {version:'1.31.6',channel:'mainline'},
    {version:'1.30.5',channel:'stable'},
    {version:'1.28.3',channel:'legacy'}
  ]);
  assert.throws(()=>parseOfficialVersions('<html>no versions</html>','darwin'));
});
test('process ownership compares executable paths per platform',()=>{
  const mine=process.platform==='win32'?'C:/Users/me/runtime/nginx.exe':'/tmp/nginx-desk/runtime/nginx';
  assert.equal(sameExecutable(mine,mine),true);
  assert.equal(sameExecutable('',mine),false);
  assert.equal(sameExecutable('/usr/sbin/nginx',mine),false);
  if(process.platform!=='win32'){
    assert.equal(sameExecutable(`nginx: master process ${mine} -p /tmp/nginx-desk/runtime/`,mine),true);
    assert.equal(sameExecutable(`${mine} (deleted)`,mine),true);
  }
});
test('files and backups recreate missing folders',{skip:!hasBundled},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nginx desk dirs '));
  const m=new Manager(root,path.resolve('vendor/nginx'));
  await m.init();
  await fs.rm(path.join(root,'conf/sites'),{recursive:true});
  await fs.rm(path.join(root,'backups'),{recursive:true});
  assert.deepEqual(await m.files(),['nginx.conf']);
  assert.deepEqual(await m.backups(),[]);
});
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
test('real nginx: configuration rollback, backups, start, HTTP, reload, stop',{skip:!hasBundled,timeout:120000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nginx desk test '));
  const m=new Manager(root,path.resolve('vendor/nginx'));
  const upstream=http.createServer((req,res)=>res.end('upstream-ok'));
  try{
    await m.init();
    const p=await port();
    const config=(await m.read('sites/default.conf')).replace('8080',String(p));
    await m.save('sites/default.conf',config);
    await assert.rejects(m.save('sites/default.conf','not_a_directive;'));
    assert.equal(await m.read('sites/default.conf'),config);
    await assert.rejects(m.save('sites/broken.conf','broken;'));
    assert.ok(!(await m.files()).includes('sites/broken.conf'));
    await assert.rejects(m.save('nginx.conf','events {} http {}'));
    assert.ok((await m.backups()).length>=1);
    assert.equal((await m.status()).running,false);
    await m.action('start');
    assert.equal((await m.status()).running,true);
    const response=await fetch(`http://127.0.0.1:${p}`);assert.equal(response.status,200);assert.match(await response.text(),/Nginx Desk/);
    await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
    const proxyPort=await port();
    await m.save('sites/proxy.conf',siteConfig({port:proxyPort,host:'localhost',kind:'proxy',target:`http://127.0.0.1:${upstream.address().port}`}));
    const staticPort=await port();
    await m.save('sites/static.conf',siteConfig({port:staticPort,host:'localhost',kind:'static',target:path.join(root,'html')}));
    await m.save('sites/default.conf',config.replace('root html;','return 200 "reload-success";'));
    await m.action('reload');
    let text='';for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));text=await(await fetch(`http://127.0.0.1:${p}`,{headers:{Connection:'close'}})).text();if(text==='reload-success')break;}
    assert.equal(text,'reload-success');
    assert.equal(await(await fetch(`http://127.0.0.1:${proxyPort}`)).text(),'upstream-ok');
    assert.match(await(await fetch(`http://127.0.0.1:${staticPort}`)).text(),/Nginx Desk/);
    await m.action('reopen');assert.match(await m.logs('access'),/GET/);
    const current=parseNginxVersion(await m.command(['-v']));
    await assert.rejects(()=>m.installVersion('../1.31.6'),/无效/);
    await assert.rejects(()=>m.installVersion(current),/停止/);
    await m.action('quit');assert.equal((await m.status()).running,false);
    assert.match(await m.installVersion(current),new RegExp(`已启用 nginx ${current}`));
    assert.equal(parseNginxVersion(await m.command(['-v'])),current);
    assert.ok((await m.installedEngines()).includes(current));
    assert.equal(await m.pinnedVersion(),current);
    await assert.rejects(()=>m.deleteVersion(current),/当前/);
    await assert.rejects(()=>m.deleteVersion('1.0.0'),/未下载/);
    await assert.rejects(()=>m.deleteVersion('../1.2.3'),/无效/);
    const extra='9.9.9';
    await fs.mkdir(path.dirname(m.engineExe(extra)),{recursive:true});
    await fs.copyFile(m.exe,m.engineExe(extra));
    assert.ok((await m.installedEngines()).includes(extra));
    assert.match(await m.deleteVersion(extra),/已删除 nginx 9\.9\.9/);
    assert.ok(!(await m.installedEngines()).includes(extra));
  }finally{
    upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
    if((await m.status()).running)await m.action('quit');
    // Keep isolated test output for diagnosis; never delete a running instance.
  }
});
