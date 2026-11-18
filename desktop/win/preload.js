'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const appInfo = (() => {
  try { return JSON.parse(process.argv.find(a => a.startsWith('--weibo-app-info='))?.slice('--weibo-app-info='.length) || '{}'); }
  catch { return {}; }
})();

contextBridge.exposeInMainWorld('weiboAppInfo', appInfo);
contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    weibo: {
      postMessage(value) {
        ipcRenderer.send('weibo-ui', value);
      }
    }
  }
});
