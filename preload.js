'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose only the permitted navigation action, never raw ipcRenderer.
contextBridge.exposeInMainWorld('flexcel', {
  openFlow: (page) => ipcRenderer.invoke('flexcel:open-flow', page)
});


// FLEXCEL_PF_FILES_PHASE2_BEGIN
// Expose specific save/open operations only; do not expose ipcRenderer itself.
{
  const pfElectron = require('electron');
  pfElectron.contextBridge.exposeInMainWorld('pfFiles', {
    save: flow => pfElectron.ipcRenderer.invoke('flexcel:pf-save', flow),
    open: () => pfElectron.ipcRenderer.invoke('flexcel:pf-open')
  });
}
// FLEXCEL_PF_FILES_PHASE2_END
