const {contextBridge,ipcRenderer} = require('electron');
const api={};
for(const name of ['state','read','save','action','logs','backups','backup','versions','installVersion','deleteVersion','generate','directory','folder','confirm'])api[name]=async arg=>{
  const r=await ipcRenderer.invoke('desk:'+name,arg);if(!r.ok)throw Error(r.error);return r.data;
};
contextBridge.exposeInMainWorld('desk',api);
