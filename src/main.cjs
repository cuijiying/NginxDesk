const {app,BrowserWindow,ipcMain,dialog,shell} = require('electron');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {Manager,siteConfig} = require('./manager.cjs');
let manager,win;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(win){win.restore();win.focus();}});
  app.whenReady().then(async()=>{
    const userData=app.getPath('userData');
    manager = new Manager(path.join(userData,'runtime'),app.isPackaged?path.join(process.resourcesPath,'nginx'):path.join(__dirname,'../vendor/nginx'),path.join(userData,'engines'));
    await manager.init();
    const page = path.join(__dirname,'index.html');
    const handlers = {
      state:async()=>({...(await manager.status()),files:await manager.files(),root:manager.root,version:(await manager.command(['-v'])).trim()}),
      read: name=>manager.read(name), save:({name,content})=>manager.save(name,content),
      action:name=>manager.action(name), logs:type=>manager.logs(type),
      backups:()=>manager.backups(), backup:name=>manager.backup(name),
      versions:()=>manager.versions(), installVersion:version=>manager.installVersion(version),
      deleteVersion:version=>manager.deleteVersion(version),
      generate:options=>siteConfig(options),
      directory:async()=>{const r=await dialog.showOpenDialog(win,{properties:['openDirectory']});return r.canceled?null:r.filePaths[0];},
      folder:()=>shell.openPath(manager.root)
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
        const {running}=await manager.status();
        if(running){
          const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['取消','停止 nginx 并退出','保持 nginx 运行并退出'],defaultId:0,cancelId:0,message:'nginx 正在运行',detail:'保持运行后，可再次打开本软件管理 nginx。'});
          if(response===0)return;
          if(response===1)await manager.action('quit');
        }
        closing=true;win.close();
      })().catch(e=>dialog.showErrorBox('退出失败',e.message));
    });
    await win.loadFile(page);
  }).catch(e=>{dialog.showErrorBox('初始化失败',e.message+'\n开发环境请先运行 npm run prepare:nginx');app.quit();});
  app.on('window-all-closed',()=>app.quit());
}
