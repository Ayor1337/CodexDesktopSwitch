import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntimePaths, type RuntimePaths } from '../electron/main/paths';
import { DEFAULT_SETTINGS, loadSettings, updateSettings } from '../electron/main/settings';

let root: string;
let paths: RuntimePaths;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-switch-settings-'));
  paths = createRuntimePaths(path.join(root, 'userData'), root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('settings store', () => {
  it('returns defaults when settings.json is missing', async () => {
    await expect(loadSettings(paths)).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('saves and loads settings patches', async () => {
    await updateSettings(paths, {
      launchAtLogin: true,
      silentStartup: true,
      closeBehavior: 'minimizeToTray',
      themeMode: 'dark',
      openAiAuthEnabled: true,
      openAiAuthProfileName: 'openai'
    });

    await expect(loadSettings(paths)).resolves.toEqual({
      version: 1,
      launchAtLogin: true,
      silentStartup: true,
      closeBehavior: 'minimizeToTray',
      themeMode: 'dark',
      openAiAuthEnabled: true,
      openAiAuthProfileName: 'openai'
    });
  });

  it('normalizes invalid theme mode to system', async () => {
    await fs.mkdir(paths.userData, { recursive: true });
    await fs.writeFile(paths.settings, JSON.stringify({ ...DEFAULT_SETTINGS, themeMode: 'sepia' }));

    await expect(loadSettings(paths)).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('disables silent startup when close behavior is quit', async () => {
    await updateSettings(paths, {
      launchAtLogin: true,
      silentStartup: true,
      closeBehavior: 'quit'
    });

    await expect(loadSettings(paths)).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      launchAtLogin: true
    });
  });

  it('rejects invalid settings shape', async () => {
    await fs.mkdir(paths.userData, { recursive: true });
    await fs.writeFile(paths.settings, JSON.stringify({ version: 2 }));

    await expect(loadSettings(paths)).rejects.toThrow(/版本无效/);
  });
});
