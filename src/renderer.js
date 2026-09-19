const $=id=>document.getElementById(id);
let activePage='overview',currentFile='',dirty=false,busy=false,polling=false;
const titles={overview:'服务概览',engines:'引擎版本',config:'配置文件',sites:'新建站点',logs:'运行日志',backups:'配置备份'};
const channels={mainline:'主线',stable:'稳定',legacy:'旧版',local:'本地',release:'发行'};
const themes=['cyan','matrix','violet','amber','crimson','ice'];
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
async function task(fn){if(busy)return;busy=true;controls().forEach(el=>el.disabled=true);try{await fn();}catch(e){output(e.message,true);}finally{busy=false;controls().forEach(el=>el.disabled=false);}}
function markDirty(value){dirty=value;$('dirty').textContent=value?'有未保存的修改':'已保存';}
async function state(){
  const s=await window.desk.state();
  $('status').textContent=s.running?'运行中':'已停止';
  $('status').dataset.state=s.running?'on':'off';
  document.body.classList.toggle('is-running',!!s.running);
  $('link-label').textContent=s.running?'ONLINE':'STANDBY';
  $('pid').textContent=s.running?`主进程 PID ${s.pid}`:'随时可以启动服务';
  $('version').textContent=s.version.replace('nginx version: ','');
  $('file-count').textContent=String(s.files.length).padStart(2,'0');
  $('root').textContent=s.root;
  const names=[...s.files];if(currentFile&&!names.includes(currentFile))names.push(currentFile);
  $('files').replaceChildren(...names.map(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;return o;}));
  if(currentFile)$('files').value=currentFile;
  return s;
}
async function loadFile(name){if(dirty&&!confirm('放弃当前未保存的修改？'))return false;$('editor').value=await window.desk.read(name);currentFile=name;$('files').value=name;markDirty(false);return true;}
async function show(page){activePage=page;document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===page));document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page));$('page-title').textContent=titles[page];if(page==='logs')await logs();if(page==='backups')await backups();if(page==='engines')await versions();}
async function logs(){$('log-content').textContent=await window.desk.logs($('log-type').value);}
async function versions(){
  const data=await window.desk.versions();
  const box=$('version-list');
  box.replaceChildren();
  if(data.error){const p=document.createElement('p');p.className='muted';p.textContent='无法获取官方列表：'+data.error+'。仍可启用已下载的版本。';box.append(p);}
  if(!data.available.length){const p=document.createElement('p');p.className='muted';p.textContent='暂无可用版本。';box.append(p);return data;}
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
    if(item.version===data.current){b.textContent='当前版本';}
    else if(data.installed.includes(item.version)){b.textContent='启用此版本';}
    else {b.textContent='安装并启用';b.className='primary';}
    b.onclick=()=>task(async()=>{
      if(item.version===data.current){output(`当前已是 nginx ${item.version}`);return;}
      if(!confirm(`将启用 nginx ${item.version}。请确认服务已停止；现有配置会保留。`))return;
      output('正在安装所选版本，请稍候…');
      output(await window.desk.installVersion(item.version));
      await state();
      await versions();
    });
    actions.append(b);
    if(data.installed.includes(item.version)&&item.version!==data.current){
      const del=document.createElement('button');del.textContent='删除';del.className='danger';
      del.onclick=()=>task(async()=>{
        if(!confirm(`将删除本地下载的 nginx ${item.version}。当前正在使用的引擎不受影响。`))return;
        output(await window.desk.deleteVersion(item.version));
        await versions();
      });
      actions.append(del);
    }
    row.append(label,actions);box.append(row);
  }
  return data;
}
async function backups(){const names=await window.desk.backups();$('backup-list').replaceChildren();if(!names.length)$('backup-list').textContent='尚无备份，保存配置后会自动生成。';for(const name of names){const row=document.createElement('div');row.className='backup-row';const label=document.createElement('span');label.textContent=name;const b=document.createElement('button');b.textContent='载入编辑器';b.onclick=()=>task(async()=>{if(dirty&&!confirm('放弃当前未保存的修改？'))return;const data=await window.desk.backup(name);currentFile=data.file;$('editor').value=data.content;markDirty(true);await state();await show('config');output('备份已载入，请校验并保存后重载。');});row.append(label,b);$('backup-list').append(row);}}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>task(()=>show(b.dataset.page)));
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>task(async()=>{if(b.dataset.action==='reload'&&dirty)throw Error('编辑器有未保存修改，请先保存或放弃修改再重载。');output('正在执行，请稍候…');output(await window.desk.action(b.dataset.action));await state();}));
$('folder').onclick=()=>task(async()=>{const error=await window.desk.folder();if(error)throw Error(error);});
$('files').onchange=()=>task(async()=>{const selected=$('files').value;if(!await loadFile(selected))$('files').value=currentFile;});
$('editor').oninput=()=>markDirty(true);
$('editor').onkeydown=e=>{if(e.key==='Tab'){e.preventDefault();const t=e.target;t.setRangeText('    ',t.selectionStart,t.selectionEnd,'end');markDirty(true);}};
$('save').onclick=()=>task(async()=>{output(await window.desk.save({name:currentFile,content:$('editor').value}));markDirty(false);await state();});
$('refresh-log').onclick=()=>task(logs);$('log-type').onchange=()=>task(logs);$('refresh-backups').onclick=()=>task(backups);$('refresh-versions').onclick=()=>task(versions);
$('pick-folder').onclick=()=>task(async()=>{const dir=await window.desk.directory();if(dir){$('site-form').elements.target.value=dir;$('site-form').elements.kind.value='static';}});
$('site-form').onsubmit=e=>{e.preventDefault();task(async()=>{if(dirty&&!confirm('放弃当前未保存的修改？'))return;const data=Object.fromEntries(new FormData(e.target));if(!/^[a-zA-Z0-9_-]+$/.test(data.name))throw Error('无效文件名');const name=`sites/${data.name}.conf`;const s=await window.desk.state();if(s.files.includes(name))throw Error('文件已存在，请使用其他名称或从配置列表编辑');const content=await window.desk.generate(data);currentFile=name;$('editor').value=content;markDirty(true);await state();await show('config');output('配置已生成，点击「校验并保存」创建站点，然后重载生效。');});};
window.addEventListener('beforeunload',e=>{if(dirty&&!confirm('有未保存的配置，确定退出？')){e.preventDefault();e.returnValue=false;}});
task(async()=>{const s=await state();await loadFile(s.files[0]);});
setInterval(async()=>{if(busy||polling)return;polling=true;try{await state();if(activePage==='logs'&&$('auto-log').checked)await logs();}catch(e){output(e.message,true);}finally{polling=false;}},5000);
