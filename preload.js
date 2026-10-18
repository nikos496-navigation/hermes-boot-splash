'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// 页面唯一能碰到的桥：读环境信息、报告「我要关了」、接收「核心已就绪」
contextBridge.exposeInMainWorld('splash', {
  info: () => ipcRenderer.invoke('splash:info'),
  exit: () => ipcRenderer.send('splash:exit'),
  onReady: (fn) => ipcRenderer.on('splash:ready', () => fn()),
  onDone: (fn) => ipcRenderer.on('splash:done', () => fn()),
})
