const $=id=>document.getElementById(id);
let activePage='overview',currentFile='',dirty=false,busy=false,polling=false,currentKind='managed';
const titles={overview:'服务概览',connections:'连接实例',engines:'引擎版本',config:'配置文件',sites:'新建站点',logs:'运行日志',backups:'配置备份'};
const channels={mainline:'主线',stable:'稳定',legacy:'旧版',local:'本地',release:'发行'};
const themes=['cyan','matrix','violet','amber','crimson','ice','noir'];
const kindLabel={managed:'本机托管',local:'本机已有',remote:'远程 SSH'};
function applyTheme(name){
  const id=themes.includes(name)?name:'cyan';
  document.documentElement.setAttribute('data-theme',id);
  localStorage.setItem('nd-theme',id);
  document.querySelectorAll('.theme-dot').forEach(b=>{
    const on=b.dataset.theme===id;
    b.classList.toggle('active',on);
    b.setAttribute('aria-pressed',on?'true':'false');
  });
}
applyTheme(localStorage.getItem('nd-theme')||'cyan');
document.querySelectorAll('.theme-dot').forEach(b=>b.onclick=()=>applyTheme(b.dataset.theme));
function output(text,error=false){$('output').textContent=(error?'操作失败：\n':'')+text;$('output').classList.toggle('is-error',error);$('operation-time').textContent=new Date().toLocaleTimeString();}
function controls(){return [...document.querySelectorAll('button')].filter(el=>!el.classList.contains('theme-dot'));}
function lock(on){
  document.body.classList.toggle('is-busy',on);
  controls().forEach(el=>{el.disabled=on;});
}
async function task(fn){
  if(busy){output('请等待当前操作完成后再试。',true);return;}
  busy=true;lock(true);
  try{return await fn();}
  catch(e){output(e.message,true);}
  finally{busy=false;lock(false);}
}
function ask(message,detail=''){return window.desk.confirm({message,detail});}
function markDirty(value){dirty=value;$('dirty').textContent=value?'有未保存的修改':'已保存';$('dirty').classList.toggle('warn',value);}
function connForm(){return $('conn-form');}
function syncConnForm(){
  const kind=connForm().elements.kind.value;
  const auth=connForm().elements.auth.value;
  $('remote-fields').hidden=kind!=='remote';
  document.querySelectorAll('.key-only').forEach(el=>{el.hidden=kind!=='remote'||auth!=='key';});
  connForm().elements.password.closest('label').hidden=kind!=='remote'||auth!=='password';
  $('pick-exe').hidden=kind==='remote';
  $('pick-prefix').hidden=kind==='remote';
}
function fillSelect(el,items,value,labelFn){
  const signature=items.map(item=>item.id).join('\n');
  if(signature!==el.dataset.list){
    el.dataset.list=signature;
    el.replaceChildren(...items.map(item=>{
      const o=document.createElement('option');
      o.value=item.id;o.textContent=labelFn(item);
      return o;
    }));
  }
  if(value)el.value=value;
}
function applyConnection(s){
  const c=s.connection||{id:'managed',name:'本机托管实例',kind:'managed',folder:true,engines:true,remote:false};
  currentKind=c.kind;
  $('folder').hidden=!c.folder;
  $('pick-folder').hidden=!!c.remote;
  $('instance-label').textContent=c.kind==='remote' ? `${c.username}@${c.host}` : (c.kind==='local' ? 'LOCAL EXISTING · NGINX' : 'LOCAL INSTANCE · NGINX DESK');
  $('workspace-label').textContent=c.kind==='remote' ? `NGINX // ${c.username}@${c.host}` : (c.kind==='local' ? 'NGINX // LOCAL EXISTING' : 'NGINX // LOCAL WORKSPACE');
  $('hero-copy').textContent=c.kind==='managed'?'从配置到运行，在一个工作台完成实时编排。':'正在管理已有 nginx。启动、停止和重载会直接作用于该实例。';
  $('engine-label').textContent=c.kind==='managed'?'内置引擎':'当前引擎';
  $('action-scope').textContent=c.kind==='managed'?'只管理当前工作目录的实例':`作用于「${c.name}」`;
  $('overview-hint').textContent=c.kind==='managed'?'默认站点：http://127.0.0.1:8080 · 首次使用请点击「启动服务」。':'停止或重载会影响到该 nginx 正在服务的站点，请确认后再操作。';
  $('root-note').textContent=c.kind==='managed'?'配置与日志保存在用户数据目录，升级软件时保留。关闭窗口时可选择保持服务运行。':(c.remote?'这是远程服务器上的路径。配置备份保存在本机用户数据目录。':'这是本机已有 nginx 的工作目录，不是软件自带的托管目录。');
  $('config-note').textContent=c.kind==='managed'?'保存前自动备份，校验失败自动回滚。主配置需保留 pid logs/nginx.pid; 。相对路径基于工作目录。':'保存前自动备份到本机，校验失败自动回滚。附加实例不强制 pid 路径。';
}
async function refreshConnections(){
  const data=await window.desk.connections();
  fillSelect($('connection-select'),data.items,data.activeId,item=>`${kindLabel[item.kind]||item.kind} · ${item.name}`);
  const box=$('connection-list');
  box.replaceChildren();
  for(const item of data.items){
    const row=document.createElement('div');row.className='backup-row';
    const label=document.createElement('span');
    const name=document.createElement('strong');name.textContent=item.name;
    const meta=document.createElement('small');meta.className='muted';
    const bits=[kindLabel[item.kind]||item.kind];
    if(item.kind==='remote')bits.push(`${item.username}@${item.host}:${item.port}`);
    else bits.push(item.prefix||item.exe);
    if(item.id===data.activeId)bits.push('当前');
    meta.textContent=' · '+bits.join(' · ');
    label.append(name,meta);
    const actions=document.createElement('div');actions.className='inline';
    if(item.id!==data.activeId){
      const use=document.createElement('button');use.textContent='切换';use.className='primary';
      use.onclick=()=>task(()=>switchConnection(item.id));
      actions.append(use);
    }
    if(item.kind!=='managed'){
      const edit=document.createElement('button');edit.textContent='编辑';
      edit.onclick=()=>{loadConnItem(item);output('已载入连接，修改后请测试并保存。');};
      const del=document.createElement('button');del.textContent='删除';del.className='danger';
      del.onclick=()=>task(async()=>{
        if(!await ask(`将删除连接「${item.name}」`,'不会停止或卸载目标机器上的 nginx。'))return;
        await window.desk.deleteConnection(item.id);
        currentFile='';markDirty(false);
        const s=await state();
        if(s.files[0])await loadFile(s.files[0],true);
        await refreshConnections();
        output('连接已删除。');
      });
      actions.append(edit,del);
    }
    row.append(label,actions);box.append(row);
  }
  if(data.error)output('上次自动连接失败，已回到本机托管实例：\n'+data.error,true);
  if(busy)lock(true);
  return data;
}
function loadConnItem(item){
  const f=connForm().elements;
  f.id.value=item.id||'';
  f.name.value=item.name||'';
  f.kind.value=item.kind==='remote'?'remote':'local';
  f.host.value=item.host||'';
  f.port.value=item.port||22;
  f.username.value=item.username||'';
  f.auth.value=item.auth||'password';
  f.password.value='';
  f.keyPath.value=item.keyPath||'';
  f.passphrase.value='';
  f.sudo.checked=!!item.sudo;
  f.exe.value=item.exe||'';
  f.prefix.value=item.prefix||'';
  f.conf.value=item.conf||'';
  $('conn-form-title').textContent=item.id?'编辑连接':'添加连接';
  syncConnForm();
}
function resetConnForm(){
  connForm().reset();
  connForm().elements.id.value='';
  connForm().elements.port.value='22';
  $('conn-form-title').textContent='添加连接';
  syncConnForm();
}
function readConnDraft(){
  const f=connForm().elements;
  return {
    id:f.id.value||undefined,
    name:f.name.value.trim(),
    kind:f.kind.value,
    host:f.host.value.trim(),
    port:f.port.value,
    username:f.username.value.trim(),
    auth:f.auth.value,
    password:f.password.value,
    keyPath:f.keyPath.value,
    passphrase:f.passphrase.value,
    sudo:f.sudo.checked,
    exe:f.exe.value.trim(),
    prefix:f.prefix.value.trim(),
    conf:f.conf.value.trim()
  };
}
async function switchConnection(id){
  if(dirty&&!await ask('切换实例将放弃当前未保存的修改？'))return;
  const data=await window.desk.connections();
  const item=data.items.find(row=>row.id===id);
  if(item&&item.needPassword){
    output('该远程连接需要 SSH 密码。请在表单中填写密码后点击「保存并连接」，或先编辑该连接。',true);
    loadConnItem(item);
    await show('connections');
    return;
  }
  output('正在切换实例…');
  const s=await window.desk.useConnection(id);
  currentFile='';markDirty(false);
  await applyState(s);
  if(s.files[0])await loadFile(s.files[0],true);
  await refreshConnections();
  output(`已切换到「${s.connection.name}」。`);
}
async function applyState(s){
  applyConnection(s);
  $('status').textContent=s.running?'运行中':'已停止';
  $('status').dataset.state=s.running?'on':'off';
  document.body.classList.toggle('is-running',!!s.running);
  $('link-label').textContent=s.running?'ONLINE':'STANDBY';
  $('pid').textContent=s.running?`主进程 PID ${s.pid}`:(currentKind==='managed'?'随时可以启动服务':'可以启动或接管该实例');
  $('version').textContent=s.version.replace('nginx version: ','');
  $('engine-platform').textContent=s.connection&&s.connection.kind==='remote'
    ? `${s.connection.username}@${s.connection.host}`
    : (({win32:'Windows 原生运行',darwin:'macOS 原生运行',linux:'Linux 原生运行'})[s.platform]||'本机原生运行');
  $('file-count').textContent=String(s.files.length).padStart(2,'0');
  $('root').textContent=s.root;
  const names=[...s.files];if(currentFile&&!names.includes(currentFile))names.push(currentFile);
  const signature=names.join('\n');
  const files=$('files');
  if(signature!==files.dataset.list){
    files.dataset.list=signature;
    files.replaceChildren(...names.map(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;return o;}));
  }
  if(currentFile)files.value=currentFile;
  const connSel=$('connection-select');
  if(s.connection&&![...connSel.options].some(o=>o.value===s.connection.id))await refreshConnections();
  else if(s.connection)connSel.value=s.connection.id;
  return s;
}
async function state(){return applyState(await window.desk.state());}
async function loadFile(name,force=false){
  if(!force&&dirty&&!await ask('放弃当前未保存的修改？'))return false;
  $('editor').value=await window.desk.read(name);currentFile=name;$('files').value=name;markDirty(false);return true;
}
async function show(page){
  activePage=page;
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===page));
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
  $('page-title').textContent=titles[page];
  if(page==='logs')await logs();
  if(page==='backups')await backups();
  if(page==='engines')await versions();
  if(page==='connections')await refreshConnections();
}
async function logs(){$('log-content').textContent=await window.desk.logs($('log-type').value);}
async function versions(refresh=false){
  const data=await window.desk.versions(!!refresh);
  $('engines-hint').textContent=currentKind!=='managed'
    ? '当前连接的是已有 nginx，不能通过本页安装或替换引擎。请切回本机托管实例，或在目标环境自行更换版本。'
    : data.platform==='win32'
    ?'从 nginx.org 下载官方 Windows zip 并替换当前引擎。安装或删除前需先停止服务；正在使用的引擎不能删除；配置、日志与站点文件会保留。'
    :'从 nginx.org 下载官方源码并在本机编译后替换当前引擎。需要 C 编译器和 make（macOS：Xcode Command Line Tools；Linux：gcc/make 及常用开发库）。安装可能需要几分钟；正在使用的引擎不能删除；配置会保留。';
  const box=$('version-list');
  box.replaceChildren();
  if(data.error){const p=document.createElement('p');p.className='muted';p.textContent=(currentKind==='managed'?'无法获取官方列表：':'')+data.error+(currentKind==='managed'?'。仍可启用已下载的版本。':'');box.append(p);}
  if(!data.available.length){const p=document.createElement('p');p.className='muted';p.textContent='暂无可用版本。';box.append(p);if(busy)lock(true);return data;}
  for(const item of data.available){
    const row=document.createElement('div');row.className='backup-row';
    const label=document.createElement('span');
    const name=document.createElement('strong');name.textContent=`nginx ${item.version}`;
    const meta=document.createElement('small');meta.className='muted';
    const marks=[channels[item.channel]||item.channel];
    if(item.version===data.current)marks.push('当前使用');
    else if(data.installed.includes(item.version))marks.push('已下载');
    meta.textContent=' · '+marks.join(' · ');
    label.append(name,meta);
    const actions=document.createElement('div');actions.className='inline';
    const b=document.createElement('button');
    if(currentKind!=='managed'){b.textContent='不可切换';b.disabled=true;}
    else if(item.version===data.current){b.textContent='当前版本';}
    else if(data.installed.includes(item.version)){b.textContent='启用此版本';}
    else {b.textContent='安装并启用';b.className='primary';}
    b.onclick=()=>task(async()=>{
      if(currentKind!=='managed')throw Error('附加实例不支持切换引擎');
      if(item.version===data.current){output(`当前已是 nginx ${item.version}`);return;}
      if(!await ask(`将启用 nginx ${item.version}`, '请确认服务已停止；现有配置会保留。'))return;
      output('正在安装所选版本，请稍候…');
      const msg=await window.desk.installVersion(item.version);
      await state();
      output(msg);
      return 'refresh-engines';
    }).then(flag=>{if(flag==='refresh-engines'&&activePage==='engines')return versions();});
    actions.append(b);
    if(currentKind==='managed'&&data.installed.includes(item.version)&&item.version!==data.current){
      const del=document.createElement('button');del.textContent='删除';del.className='danger';
      del.onclick=()=>task(async()=>{
        if(!await ask(`将删除本地下载的 nginx ${item.version}`, '当前正在使用的引擎不受影响。'))return;
        output(await window.desk.deleteVersion(item.version));
        return 'refresh-engines';
      }).then(flag=>{if(flag==='refresh-engines'&&activePage==='engines')return versions();});
      actions.append(del);
    }
    row.append(label,actions);box.append(row);
  }
  if(busy)lock(true);
  return data;
}
async function backups(){
  const names=await window.desk.backups();
  $('backup-list').replaceChildren();
  if(!names.length)$('backup-list').textContent='尚无备份，保存配置后会自动生成。';
  for(const name of names){
    const row=document.createElement('div');row.className='backup-row';
    const label=document.createElement('span');label.textContent=name;
    const b=document.createElement('button');b.textContent='载入编辑器';
    b.onclick=()=>task(async()=>{
      if(dirty&&!await ask('放弃当前未保存的修改？'))return;
      const data=await window.desk.backup(name);
      currentFile=data.file;$('editor').value=data.content;markDirty(true);
      await state();await show('config');
      output('备份已载入，请校验并保存后重载。');
    });
    row.append(label,b);$('backup-list').append(row);
  }
  if(busy)lock(true);
}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>task(()=>show(b.dataset.page)));
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>task(async()=>{
  if(b.dataset.action==='reload'&&dirty)throw Error('编辑器有未保存修改，请先保存或放弃修改再重载。');
  if(currentKind!=='managed'&&(b.dataset.action==='quit'||b.dataset.action==='start')&&!await ask(
    b.dataset.action==='quit'?'将停止已有 nginx 实例':'将启动已有 nginx 实例',
    '这会作用于当前连接的本机或远程 nginx，而不是仅限软件自带的托管目录。'
  ))return;
  output('正在执行，请稍候…');output(await window.desk.action(b.dataset.action));await state();
}));
$('folder').onclick=()=>task(async()=>{const error=await window.desk.folder();if(error)throw Error(error);});
$('files').onchange=()=>task(async()=>{
  const selected=$('files').value;
  try{if(!await loadFile(selected))$('files').value=currentFile;}
  catch(e){$('files').value=currentFile;throw e;}
});
$('editor').oninput=()=>markDirty(true);
$('editor').onkeydown=e=>{if(e.key==='Tab'){e.preventDefault();const t=e.target;t.setRangeText('    ',t.selectionStart,t.selectionEnd,'end');markDirty(true);}};
$('save').onclick=()=>task(async()=>{output(await window.desk.save({name:currentFile,content:$('editor').value}));markDirty(false);await state();});
$('refresh-log').onclick=()=>task(logs);$('log-type').onchange=()=>task(logs);$('refresh-backups').onclick=()=>task(backups);$('refresh-versions').onclick=()=>task(()=>versions(true));
$('pick-folder').onclick=()=>task(async()=>{const dir=await window.desk.directory();if(dir){$('site-form').elements.target.value=dir;$('site-form').elements.kind.value='static';}});
$('site-form').onsubmit=e=>{e.preventDefault();task(async()=>{if(dirty&&!await ask('放弃当前未保存的修改？'))return;const data=Object.fromEntries(new FormData(e.target));if(!/^[a-zA-Z0-9_-]+$/.test(data.name))throw Error('无效文件名');const name=`sites/${data.name}.conf`;const s=await window.desk.state();if(s.files.includes(name))throw Error('文件已存在，请使用其他名称或从配置列表编辑');const content=await window.desk.generate(data);currentFile=name;$('editor').value=content;markDirty(true);await state();await show('config');output('配置已生成，点击「校验并保存」创建站点，然后重载生效。');});};
$('connection-select').onchange=()=>task(async()=>{
  const id=$('connection-select').value;
  try{await switchConnection(id);}
  catch(e){await refreshConnections();throw e;}
});
connForm().elements.kind.onchange=syncConnForm;
connForm().elements.auth.onchange=syncConnForm;
$('reset-conn').onclick=()=>resetConnForm();
$('refresh-connections').onclick=()=>task(refreshConnections);
$('pick-exe').onclick=()=>task(async()=>{const file=await window.desk.pickFile('exe');if(file)connForm().elements.exe.value=file;});
$('pick-prefix').onclick=()=>task(async()=>{const dir=await window.desk.directory();if(dir)connForm().elements.prefix.value=dir;});
$('pick-key').onclick=()=>task(async()=>{const file=await window.desk.pickFile('key');if(file)connForm().elements.keyPath.value=file;});
$('discover-local').onclick=()=>task(async()=>{
  output('正在探测本机 nginx…');
  const found=await window.desk.discover();
  const box=$('discover-list');box.replaceChildren();
  if(!found.length){$('discover-status').textContent='未发现本机 nginx。可手动填写可执行文件和工作目录。';output('未发现本机 nginx。');return;}
  $('discover-status').textContent=`发现 ${found.length} 个本机 nginx，点击一项填入表单。`;
  for(const item of found){
    const row=document.createElement('div');row.className='backup-row';
    const label=document.createElement('span');
    label.textContent=`nginx ${item.version||'?'} · ${item.exe}`;
    const b=document.createElement('button');b.textContent='填入表单';
    b.onclick=()=>{
      loadConnItem({name:'本机已有 nginx',kind:'local',exe:item.exe,prefix:item.prefix,conf:item.conf,pid:item.pid});
      output(`已填入 ${item.exe}`);
    };
    row.append(label,b);box.append(row);
  }
  output(`发现 ${found.length} 个本机 nginx。`);
});
$('probe-conn').onclick=()=>task(async()=>{
  output('正在测试连接…');
  const r=await window.desk.probe(readConnDraft());
  connForm().elements.exe.value=r.exe;
  connForm().elements.prefix.value=r.prefix;
  connForm().elements.conf.value=r.conf;
  output(`连接成功：nginx ${r.version||'未知'} · ${r.running?'运行中':'未运行'} · ${r.conf}`);
});
connForm().onsubmit=e=>{e.preventDefault();task(async()=>{
  output('正在保存并连接…');
  const saved=await window.desk.saveConnection(readConnDraft());
  connForm().elements.password.value='';
  connForm().elements.passphrase.value='';
  await switchConnection(saved.id);
});};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=false;}});
syncConnForm();
task(async()=>{
  await refreshConnections();
  const s=await state();
  await loadFile(s.files[0],true);
  if(s.connection&&s.connection.kind!=='managed')output(`当前实例：${s.connection.name}`);
});
setInterval(async()=>{if(busy||polling)return;polling=true;try{await state();if(activePage==='logs'&&$('auto-log').checked)await logs();}catch{/* keep last good state */}finally{polling=false;}},5000);
