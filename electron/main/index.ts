import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import TOML from '@iarna/toml';
import { createRuntimePaths } from './paths';
import { CodexSwitchService } from './service';
import { restartCodexProcesses } from './processes';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: 'Codex Switch',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  const service = new CodexSwitchService(createRuntimePaths(app.getPath('userData')));

  ipcMain.handle('profiles:list', () => service.listProfiles());
  ipcMain.handle('profiles:create', (_event, profile) => service.createProfile(profile));
  ipcMain.handle('profiles:update', (_event, name, patch) => service.updateProfile(name, patch));
  ipcMain.handle('profiles:delete', (_event, name) => service.deleteProfile(name));
  ipcMain.handle('profiles:rename', (_event, oldName, newName) => service.renameProfile(oldName, newName));
  ipcMain.handle('profiles:importCurrent', (_event, name) => service.importCurrent(name));
  ipcMain.handle('profiles:switch', (_event, name) => service.switchProfile(name));
  ipcMain.handle('codex:readCurrent', () => service.readCurrent());
  ipcMain.handle('codex:detectActiveProfile', () => service.detectActiveProfile());
  ipcMain.handle('codex:parseToml', (_event, text) => TOML.parse(text));
  ipcMain.handle('codex:stringifyToml', (_event, value) => TOML.stringify(value || {}));
  ipcMain.handle('codex:restart', () => restartCodexProcesses());
  ipcMain.handle('backup:list', () => service.listBackups());
  ipcMain.handle('backup:restore', (_event, backupId) => service.restoreBackup(backupId));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
