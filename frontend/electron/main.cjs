const { app, BrowserWindow } = require('electron');
const path = require('path');
function createWindow(){
 const win=new BrowserWindow({width:1440,height:920,minWidth:1100,minHeight:700,
  webPreferences:{contextIsolation:true,nodeIntegration:false}});
 win.loadURL('http://127.0.0.1:5173');
}
app.whenReady().then(createWindow);
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
