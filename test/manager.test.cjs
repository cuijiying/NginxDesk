const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const http=require('node:http');
const {Manager,siteConfig}=require('../src/manager.cjs');
test('reject injection and invalid ports',()=>{
  for(const port of [0,65536,'80;'])assert.throws(()=>siteConfig({port,host:'localhost',kind:'proxy',target:'http://localhost'}));
  assert.throws(()=>siteConfig({port:8080,host:'x;}',kind:'static',target:'C:/www'}));
  assert.throws(()=>siteConfig({port:8080,host:'localhost',kind:'static',target:'C:/www";'}));
  const m=new Manager('C:/tmp','');assert.throws(()=>m.file('../secrets'));assert.throws(()=>m.file('sites/../../secrets'));
});
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
test('real nginx: configuration rollback, backups, start, HTTP, reload, stop',{skip:process.platform!=='win32',timeout:120000},async()=>{
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
    await m.action('quit');assert.equal((await m.status()).running,false);
  }finally{
    upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
    if((await m.status()).running)await m.action('quit');
    // Keep isolated test output for diagnosis; never delete a running instance.
  }
});
