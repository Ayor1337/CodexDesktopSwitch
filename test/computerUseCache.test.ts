import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TOML from '@iarna/toml';
import { repairComputerUseCache } from '../electron/main/computerUseCache';
import { createRuntimePaths, type RuntimePaths } from '../electron/main/paths';

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: execFileMock,
    spawn: spawnMock
  };
});

let root: string;
let paths: RuntimePaths;

async function writeFile(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-switch-computer-use-'));
  paths = createRuntimePaths(path.join(root, 'userData'), root);

  execFileMock.mockImplementation((file: string, args: string[], options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (file === 'taskkill.exe') {
      callback(null, { stdout: '', stderr: '' });
      return { on: vi.fn() };
    }
    if (args.join(' ').includes('Get-CimInstance')) {
      callback(null, { stdout: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe\r\n', stderr: '' });
      return { on: vi.fn() };
    }
    if (args.join(' ').includes('SetEnvironmentVariable')) {
      callback(null, { stdout: '', stderr: '' });
      return { on: vi.fn() };
    }
    callback(new Error(`unexpected command: ${file} ${args.join(' ')}`), { stdout: '', stderr: '' });
    return { on: vi.fn() };
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('repairComputerUseCache', () => {
  it('removes old local computer-use cache and config overrides while keeping feature enabled', async () => {
    const marketplaceRoot = path.join(paths.codexDir, '.tmp', 'bundled-marketplaces', 'openai-bundled');
    const computerUseCacheRoot = path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled', 'computer-use');
    const browserCacheRoot = path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled', 'browser', 'latest');
    const chromeCacheRoot = path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled', 'chrome', 'latest');

    await writeFile(path.join(marketplaceRoot, 'plugins', 'computer-use', '.codex-plugin', 'plugin.json'), '{"name":"computer-use"}');
    await writeFile(path.join(computerUseCacheRoot, '0.1.0-local', '.codex-plugin', 'plugin.json'), '{"name":"computer-use"}');
    await writeFile(path.join(browserCacheRoot, '.codex-plugin', 'plugin.json'), '{"name":"browser"}');
    await writeFile(path.join(chromeCacheRoot, '.codex-plugin', 'plugin.json'), '{"name":"chrome"}');
    await writeFile(
      paths.config,
      TOML.stringify({
        model: 'gpt-5',
        features: {
          legacy: true,
          computer_use: false
        },
        windows: {
          sandbox: 'unelevated'
        },
        marketplaces: {
          'openai-bundled': {
            source: `\\\\?\\${marketplaceRoot}`,
            source_type: 'local'
          }
        },
        plugins: {
          'computer-use@openai-bundled': {
            enabled: true
          }
        },
        mcp_servers: {
          node_repl: {
            args: [],
            command: 'C:\\Users\\ayor\\AppData\\Local\\OpenAI\\Codex\\bin\\34ab3e1324cc55b5\\node_repl.exe',
            startup_timeout_sec: 120,
            env: {
              NODE_REPL_NODE_PATH: 'C:\\Users\\ayor\\AppData\\Local\\OpenAI\\Codex\\bin\\5b9024f90663758b\\node.exe',
              CODEX_CLI_PATH: 'C:\\Users\\ayor\\AppData\\Local\\OpenAI\\Codex\\bin\\fb2111b91430cb17\\codex.exe',
              BROWSER_USE_CODEX_APP_VERSION: '26.602.40724',
              CODEX_HOME: paths.codexDir
            }
          },
          custom: {
            command: 'custom-mcp.exe'
          }
        }
      })
    );

    const result = await repairComputerUseCache(paths);
    const configText = await fs.readFile(paths.config, 'utf8');

    expect(result.backupPath).toBeTruthy();
    expect(result.configUpdated).toBe(true);
    expect(result.restart.started).toBe(process.platform === 'win32');
    expect(result.removedPaths).toEqual(expect.arrayContaining([computerUseCacheRoot, marketplaceRoot]));
    expect(await fs.readFile(result.backupPath!, 'utf8')).toContain('[marketplaces.openai-bundled]');
    await expect(pathExists(computerUseCacheRoot)).resolves.toBe(false);
    await expect(pathExists(marketplaceRoot)).resolves.toBe(false);
    await expect(pathExists(browserCacheRoot)).resolves.toBe(true);
    await expect(pathExists(chromeCacheRoot)).resolves.toBe(true);
    expect(configText).not.toContain('[marketplaces.openai-bundled]');
    expect(configText).not.toContain('[plugins."computer-use@openai-bundled"]');
    expect(configText).not.toContain('[mcp_servers.node_repl]');
    expect(configText).not.toContain('NODE_REPL_NODE_PATH');
    expect(configText).toContain('[mcp_servers.custom]');
    expect(configText).toContain('command = "custom-mcp.exe"');
    expect(configText).toContain('[features]');
    expect(configText).toContain('legacy = true');
    expect(configText).toContain('computer_use = true');
    expect(result.environmentEnabled).toBe(process.platform === 'win32');
    if (process.platform === 'win32') {
      expect(execFileMock).toHaveBeenCalledWith('taskkill.exe', ['/IM', 'codex.exe', '/F', '/T'], expect.anything(), expect.any(Function));
      expect(execFileMock).toHaveBeenCalledWith('taskkill.exe', ['/IM', 'extension-host.exe', '/F', '/T'], expect.anything(), expect.any(Function));
      expect(execFileMock).toHaveBeenCalledWith('taskkill.exe', ['/IM', 'extensionHost.exe', '/F', '/T'], expect.anything(), expect.any(Function));
      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe',
        [],
        expect.objectContaining({ detached: true, shell: false })
      );
      expect(execFileMock).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-NoProfile', '-Command', expect.stringContaining('SetEnvironmentVariable')]),
        expect.anything(),
        expect.any(Function)
      );
    }
  });

  it('creates minimal config when it is missing', async () => {
    const result = await repairComputerUseCache(paths);
    const configText = await fs.readFile(paths.config, 'utf8');

    expect(result.backupPath).toBeNull();
    expect(result.configUpdated).toBe(true);
    expect(result.removedPaths).toEqual([]);
    expect(configText).toContain('[features]');
    expect(configText).toContain('computer_use = true');
    expect(configText).not.toContain('[marketplaces.openai-bundled]');
    expect(configText).not.toContain('[plugins."computer-use@openai-bundled"]');
  });
});
