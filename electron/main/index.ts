import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, shell, Tray } from 'electron';
import TOML from '@iarna/toml';
import type { AppSettings } from '../../src/types';
import { createRuntimePaths } from './paths';
import { CodexSwitchService } from './service';
import { restartCodexProcesses } from './processes';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settingsSnapshot: AppSettings | null = null;
let isQuitting = false;
const SILENT_STARTUP_ARG = '--silent-startup';

function getAppIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(process.cwd(), 'resources/icon.png');
}

function showMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
}

function syncTray(): void {
  if (settingsSnapshot?.closeBehavior !== 'minimizeToTray') {
    tray?.destroy();
    tray = null;
    return;
  }

  if (!tray) {
    tray = new Tray(getAppIconPath());
    tray.setToolTip('Codex Switch');
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 Codex Switch', click: showMainWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function applySettings(settings: AppSettings): void {
  settingsSnapshot = settings;
  syncTray();

  if (!app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: false,
      args: []
    });
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    args: settings.launchAtLogin && settings.silentStartup ? [SILENT_STARTUP_ARG] : []
  });
}

function createWindow(showOnReady = true): void {
  const windowIcon = getAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: 'Codex Switch',
    icon: windowIcon,
    show: false,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: '#f7f7f4',
    roundedCorners: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    if (showOnReady) mainWindow?.show();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting || settingsSnapshot?.closeBehavior !== 'minimizeToTray') return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximizeChanged', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximizeChanged', false);
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

function registerIpc(service: CodexSwitchService): void {
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
  ipcMain.handle('codex:proxyStatus', () => service.getProxyStatus());
  ipcMain.handle('codex:repairComputerUseCache', () => service.repairComputerUseCache());
  ipcMain.handle('backup:list', () => service.listBackups());
  ipcMain.handle('backup:restore', (_event, backupId) => service.restoreBackup(backupId));
  ipcMain.handle('settings:get', () => service.getSettings());
  ipcMain.handle('settings:update', async (_event, patch) => {
    const settings = await service.updateSettings(patch);
    applySettings(settings);
    return settings;
  });
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });
  ipcMain.handle('window:maximize-toggle', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    }
    mainWindow.maximize();
    return true;
  });
  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);
}

app.whenReady().then(() => {
  const service = new CodexSwitchService(createRuntimePaths(app.getPath('userData')));
  registerIpc(service);
  service.getSettings().then(applySettings).catch(console.error);
  service.restoreActiveProxy().catch((error) => console.error('Failed to restore proxy:', error));
  createWindow(!process.argv.includes(SILENT_STARTUP_ARG));

  app.on('activate', () => {
    showMainWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    service.shutdown().catch((error) => console.error('Proxy shutdown failed:', error));
  });
});

app.on('window-all-closed', () => {
  if (settingsSnapshot?.closeBehavior === 'minimizeToTray' && !isQuitting) return;
  if (process.platform !== 'darwin') app.quit();
});
