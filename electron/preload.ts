import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi, ProfileInput } from '../src/types';

const api: AppApi = {
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    create: (profile: ProfileInput) => ipcRenderer.invoke('profiles:create', profile),
    update: (name: string, patch: Partial<ProfileInput>) => ipcRenderer.invoke('profiles:update', name, patch),
    delete: (name: string) => ipcRenderer.invoke('profiles:delete', name),
    rename: (oldName: string, newName: string) => ipcRenderer.invoke('profiles:rename', oldName, newName),
    importCurrent: (name: string) => ipcRenderer.invoke('profiles:importCurrent', name),
    syncCurrentOfficialAuth: (name: string) => ipcRenderer.invoke('profiles:syncCurrentOfficialAuth', name),
    switch: (name: string) => ipcRenderer.invoke('profiles:switch', name)
  },
  codex: {
    readCurrent: () => ipcRenderer.invoke('codex:readCurrent'),
    detectActiveProfile: () => ipcRenderer.invoke('codex:detectActiveProfile'),
    parseToml: (text: string) => ipcRenderer.invoke('codex:parseToml', text),
    stringifyToml: (value: Record<string, unknown>) => ipcRenderer.invoke('codex:stringifyToml', value),
    restart: () => ipcRenderer.invoke('codex:restart'),
    proxyStatus: () => ipcRenderer.invoke('codex:proxyStatus'),
    repairComputerUseCache: () => ipcRenderer.invoke('codex:repairComputerUseCache')
  },
  backup: {
    list: () => ipcRenderer.invoke('backup:list'),
    restore: (backupId: string) => ipcRenderer.invoke('backup:restore', backupId)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch)
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (cb: (value: boolean) => void) => {
      const listener = (_: unknown, value: boolean) => cb(value);
      ipcRenderer.on('window:maximizeChanged', listener);
      return () => ipcRenderer.off('window:maximizeChanged', listener);
    }
  }
};

contextBridge.exposeInMainWorld('codexSwitch', api);
