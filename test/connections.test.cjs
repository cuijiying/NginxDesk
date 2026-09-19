const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const fsSync=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Hub,probeLocalInstall}=require('../src/hub.cjs');
const {Manager,attachedConfName,siteConfig}=require('../src/manager.cjs');
const {
  parseNginxBuild, parsePidDirective, parseLogDirective, parseNginxArgv,
  assertSafeHost, assertSafeUser, assertSafePath, shQuote, posixJoin, resolveAgainst
}=require('../src/inspect.cjs');
const {nginxBin}=require('../src/platform.cjs');
const hasBundled=fsSync.existsSync(path.resolve('vendor/nginx',nginxBin));

test('parse nginx -V, pid and log directives',()=>{
  const text=`nginx version: nginx/1.24.0
configure arguments: --prefix=/etc/nginx --sbin-path=/usr/sbin/nginx --conf-path=/etc/nginx/nginx.conf --error-log-path=/var/log/nginx/error.log --http-log-path=/var/log/nginx/access.log --pid-path=/run/nginx.pid --with-http_ssl_module`;
  assert.deepEqual(parseNginxBuild(text),{
    version:'1.24.0', prefix:'/etc/nginx', exe:'/usr/sbin/nginx', conf:'/etc/nginx/nginx.conf',
    pid:'/run/nginx.pid', errorLog:'/var/log/nginx/error.log', accessLog:'/var/log/nginx/access.log'
  });
  const conf=`# pid /tmp/ignore.pid;
pid logs/nginx.pid;
error_log logs/error.log warn;
access_log logs/access.log main;`;
  assert.equal(parsePidDirective(conf),'logs/nginx.pid');
  assert.equal(parseLogDirective(conf,'error_log'),'logs/error.log');
  assert.equal(parseLogDirective(conf,'access_log'),'logs/access.log');
  assert.deepEqual(parseNginxArgv('nginx.exe -p D:\\java\\nginx-1.28.3\\ -c conf/nginx.conf'),{
    prefix:'D:\\java\\nginx-1.28.3', conf:'conf/nginx.conf'
  });
  assert.deepEqual(parseNginxArgv('"D:\\java\\nginx-1.28.3\\nginx.exe" -p "D:\\java\\nginx-1.28.3"'),{
    prefix:'D:\\java\\nginx-1.28.3', conf:''
  });
});

test('reject unsafe connection fields and quote ssh args',()=>{
  assert.throws(()=>assertSafeHost('bad host'));
  assert.throws(()=>assertSafeHost('evil;rm'));
  assert.throws(()=>assertSafeHost('host$(id)'));
  assert.equal(assertSafeHost('nginx.example.com'),'nginx.example.com');
  assert.equal(assertSafeHost('127.0.0.1'),'127.0.0.1');
  assert.throws(()=>assertSafeUser('root;id'));
  assert.throws(()=>assertSafePath('../etc/nginx.conf','路径'));
  assert.throws(()=>assertSafePath('/tmp/nginx;id','路径'));
  assert.equal(shQuote(`foo'bar`),"'foo'\\''bar'");
  assert.equal(posixJoin('/etc/nginx','conf.d/a.conf'),'/etc/nginx/conf.d/a.conf');
  assert.equal(resolveAgainst('/etc/nginx','logs/nginx.pid',true),'/etc/nginx/logs/nginx.pid');
  assert.equal(resolveAgainst('/etc/nginx','/run/nginx.pid',true),'/run/nginx.pid');
  assert.equal(attachedConfName('nginx.conf'),true);
  assert.equal(attachedConfName('conf.d/app.conf'),true);
  assert.equal(attachedConfName('sites-enabled/default'),true);
  assert.equal(attachedConfName('../secret'),false);
  assert.equal(attachedConfName('sites/../../x.conf'),false);
});

test('hub stores local connections and rejects deleting managed instance',{skip:!hasBundled,timeout:30000},async()=>{
  const userData=await fs.mkdtemp(path.join(os.tmpdir(),'nginx-desk-hub-'));
  const hub=new Hub(userData,path.resolve('vendor/nginx'),{
    encrypt:s=>Buffer.from(s,'utf8').toString('base64'),
    decrypt:s=>Buffer.from(s,'base64').toString('utf8')
  });
  await hub.init();
  const list=hub.list();
  assert.equal(list.items[0].id,'managed');
  await assert.rejects(()=>hub.remove('managed'),/不能删除/);
  await assert.rejects(()=>hub.save({name:'x',kind:'remote',host:'bad host',username:'root',exe:'/usr/sbin/nginx',prefix:'/etc/nginx',conf:'/etc/nginx/nginx.conf',password:'x'}),/主机/);
  const saved=await hub.save({
    name:'本机附加',
    kind:'local',
    exe:hub.managed.exe,
    prefix:hub.managed.root,
    conf:path.join(hub.managed.root,'conf/nginx.conf')
  });
  assert.equal(saved.kind,'local');
  const snap=await hub.use(saved.id);
  assert.equal(snap.connection.id,saved.id);
  assert.ok(snap.files.includes('nginx.conf'));
  await hub.use('managed');
  assert.equal(hub.activeId,'managed');
  await hub.remove(saved.id);
  assert.equal(hub.list().items.length,1);
});

test('attached local manager reads existing prefix without rewriting it',{skip:!hasBundled,timeout:60000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nginx desk attach '));
  const owned=new Manager(root,path.resolve('vendor/nginx'));
  await owned.init();
  const original=await owned.read('nginx.conf');
  const attached=new Manager(root,path.resolve('vendor/nginx'),path.join(root,'engines'),{
    kind:'local', exe:owned.exe, confPath:path.join(root,'conf/nginx.conf')
  });
  await attached.init();
  assert.equal(await attached.read('nginx.conf'),original);
  assert.deepEqual(await attached.files(),await owned.files());
  assert.throws(()=>attached.file('../secrets'));
  await assert.rejects(()=>attached.installVersion('1.0.0'),/不支持/);
  const extra=siteConfig({port:18081,host:'localhost',kind:'proxy',target:'http://127.0.0.1:9'});
  await attached.save('sites/extra.conf',extra);
  assert.ok((await attached.files()).includes('sites/extra.conf'));
  const current=await attached.read('sites/default.conf');
  await attached.save('sites/default.conf', current.replace('8080','18080'));
  assert.ok((await attached.backups()).length>=1);
});

test('probe local install uses exe directory when build prefix is missing',{skip:!hasBundled},async()=>{
  const exe=path.resolve('vendor/nginx',nginxBin);
  const item=await probeLocalInstall(exe);
  assert.equal(path.normalize(item.exe),exe);
  assert.ok(item.version);
  assert.ok(item.prefix);
  await fs.access(item.conf);
  assert.equal(await probeLocalInstall(exe,{},exe),null);
});
