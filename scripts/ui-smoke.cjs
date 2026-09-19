const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
// Exercise the real desktop preload and IPC in an isolated user profile.
app.setPath('userData',path.join(os.tmpdir(),'nginx-desk-ui-'+Date.now()));
const timeout=setTimeout(()=>{console.error('UI smoke timed out');app.exit(1);},60000);
app.on('browser-window-created',(_e,win)=>{
  win.webContents.once('did-finish-load',async()=>{
    try{
      await new Promise(r=>setTimeout(r,2500));
      const result=await win.webContents.executeJavaScript(`(async()=>{
        const state=await window.desk.state();
        if(state.running || !state.files.includes('nginx.conf'))throw Error('Bad initial state');
        if(!document.getElementById('editor').value.includes('worker_processes'))throw Error('Editor did not load');
        document.querySelector('[data-page="engines"]').click();
        let list='';
        for(let i=0;i<20;i++){
          await new Promise(r=>setTimeout(r,500));
          list=document.getElementById('version-list').textContent;
          if(document.getElementById('engines').classList.contains('active')&&/nginx 1\.|无法获取官方列表|暂无可用版本/.test(list))break;
        }
        if(!document.getElementById('engines').classList.contains('active'))throw Error('Engines navigation failed');
        if(!/nginx 1\.|无法获取官方列表|暂无可用版本/.test(list))throw Error('Version list did not render: '+list);
        await new Promise(r=>setTimeout(r,400));
        document.querySelector('[data-page="sites"]').click();
        await new Promise(r=>setTimeout(r,400));
        document.getElementById('site-form').requestSubmit();
        await new Promise(r=>setTimeout(r,1500));
        if(!document.getElementById('editor').value.includes('proxy_pass'))throw Error('Site generation failed');
        if(!document.getElementById('config').classList.contains('active'))throw Error('Navigation failed');
        document.querySelector('[data-page="overview"]').click();
        await new Promise(r=>setTimeout(r,300));
        document.querySelector('.theme-dot[data-theme="noir"]').click();
        if(document.documentElement.getAttribute('data-theme')!=='noir')throw Error('Noir theme switch failed');
        document.querySelector('.theme-dot[data-theme="violet"]').click();
        if(document.documentElement.getAttribute('data-theme')!=='violet')throw Error('Theme switch failed');
        document.querySelector('.theme-dot[data-theme="cyan"]').click();
        await new Promise(r=>setTimeout(r,400));
        return {files:state.files,version:state.version,theme:document.documentElement.getAttribute('data-theme')};
      })()`);
      await fs.mkdir(path.resolve('artifacts'),{recursive:true});
      await fs.writeFile(path.resolve('artifacts/desktop-smoke.png'),(await win.webContents.capturePage()).toPNG());
      console.log('UI_SMOKE_OK',JSON.stringify(result));clearTimeout(timeout);app.exit(0);
    }catch(e){console.error(e && e.stack || e);clearTimeout(timeout);app.exit(1);}
  });
});
require('../src/main.cjs');
