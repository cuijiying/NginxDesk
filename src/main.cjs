const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {siteConfig} = require('./manager.cjs');
const {Hub} = require('./hub.cjs');
let hub,win;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(win){win.restore();win.focus();}});
  app.whenReady().then(async()=>{
    const userData=app.getPath('userData');
    const encrypt = safeStorage.isEncryptionAvailable() ? value => safeStorage.encryptString(value).toString('base64') : undefined;
    const decrypt = safeStorage.isEncryptionAvailable() ? value => safeStorage.decryptString(Buffer.from(value,'base64')) : undefined;
    hub = new Hub(userData, app.isPackaged?path.join(process.resourcesPath,'nginx'):path.join(__dirname,'../vendor/nginx'), {encrypt, decrypt});
    await hub.init();
    const page = path.join(__dirname,'index.html');
    const handlers = {
      state:()=>hub.snapshot(),
      read: name=>hub.current.read(name), save:({name,content})=>hub.current.save(name,content),
      action:name=>hub.current.action(name), logs:type=>hub.current.logs(type),
      backups:()=>hub.current.backups(), backup:name=>hub.current.backup(name),
      versions:refresh=>hub.current.versions(refresh), installVersion:version=>hub.current.installVersion(version),
      deleteVersion:version=>hub.current.deleteVersion(version),
      generate:options=>siteConfig(options),
      connections:()=>hub.list(),
      discover:()=>hub.discoverLocal(),
      probe:draft=>hub.probeDraft(draft),
      saveConnection:draft=>hub.save(draft),
      deleteConnection:id=>hub.remove(id),
      useConnection:id=>hub.use(id),
      unlockConnection:({id,password})=>hub.unlock(id,password),
      directory:async()=>{const r=await dialog.showOpenDialog(win,{properties:['openDirectory']});return r.canceled?null:r.filePaths[0];},
      pickFile:async kind=>{
        const filters = kind==='exe'
          ? (process.platform==='win32'?[{name:'nginx',extensions:['exe']}]:[{name:'nginx',extensions:['*']}])
          : kind==='key' ? [{name:'私钥',extensions:['','pem','key']}] : [];
        const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters});
        return r.canceled?null:r.filePaths[0];
      },
      folder:async()=>{
        if(hub.current.io && hub.current.io.remote) throw Error('远程实例没有本地工作目录：'+hub.current.root);
        return shell.openPath(hub.current.root);
      },
      confirm:async arg=>{
        const message=typeof arg==='string'?arg:(arg&&arg.message)||'请确认';
        const detail=typeof arg==='string'?'':(arg&&arg.detail)||'';
        const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['取消','确定'],defaultId:1,cancelId:0,message,detail});
        return response===1;
      }
    };
    for(const [name,fn] of Object.entries(handlers)) ipcMain.handle('desk:'+name,async(event,arg)=>{
      if(event.senderFrame?.url !== pathToFileURL(page).href)throw Error('不可信的请求来源');
      try{return {ok:true,data:await fn(arg)};}catch(e){return {ok:false,error:e.message};}
    });
    win = new BrowserWindow({width:1280,height:860,minWidth:1100,minHeight:720,backgroundColor:'#05080f',title:'Nginx Desk',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',e=>e.preventDefault());
    let closing=false;
    win.on('close',e=>{
      if(closing)return;e.preventDefault();
      (async()=>{
        const {running}=await hub.current.status();
        if(running){
          const meta=hub.connectionMeta();
          const where=meta.kind==='remote'?`远程 ${meta.username}@${meta.host}`:meta.name;
          const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['取消','停止 nginx 并退出','保持 nginx 运行并退出'],defaultId:0,cancelId:0,message:`${where} 上的 nginx 正在运行`,detail:'保持运行后，可再次打开本软件管理该实例。停止会作用于当前连接的 nginx。'});
          if(response===0)return;
          if(response===1)await hub.current.action('quit');
        }
        closing=true;win.close();
      })().catch(e=>dialog.showErrorBox('退出失败',e.message));
    });
    await win.loadFile(page);
  }).catch(e=>{dialog.showErrorBox('初始化失败',e.message+'\n开发环境请先运行 npm run prepare:nginx');app.quit();});
  app.on('window-all-closed',()=>app.quit());
}
