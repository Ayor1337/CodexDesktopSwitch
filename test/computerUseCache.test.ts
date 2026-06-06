import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repairComputerUseCache } from '../electron/main/computerUseCache';
import { createRuntimePaths, type RuntimePaths } from '../electron/main/paths';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: execFileMock
  };
});

let root: string;
let paths: RuntimePaths;
let installLocation: string;

async function writeJson(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePlugin(rootPath: string, name: string, version: string): Promise<void> {
  const pluginRoot = path.join(rootPath, 'plugins', name);
  await writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), { name, version });
  await fs.mkdir(path.join(pluginRoot, 'extension-host', 'windows', 'x64'), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, 'extension-host', 'windows', 'x64', 'extension-host.exe'), 'exe');
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-switch-computer-use-'));
  paths = createRuntimePaths(path.join(root, 'userData'), root);
  installLocation = path.join(root, 'WindowsApps', 'OpenAI.Codex_1.0.0.0_x64__test');
  const bundledRoot = path.join(installLocation, 'app', 'resources', 'plugins', 'openai-bundled');

  await fs.mkdir(paths.codexDir, { recursive: true });
  await writeJson(path.join(bundledRoot, '.agents', 'plugins', 'marketplace.json'), {
    name: 'openai-bundled',
    interface: { displayName: 'OpenAI Bundled' },
    plugins: [
      { name: 'browser', source: { source: 'local', path: './plugins/browser' } },
      { name: 'chrome', source: { source: 'local', path: './plugins/chrome' } }
    ]
  });
  await writePlugin(bundledRoot, 'browser', '1.2.3');
  await writePlugin(bundledRoot, 'chrome', '4.5.6');

  execFileMock.mockImplementation((file: string, args: string[], options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (args.join(' ').includes('Get-AppxPackage')) {
      callback(null, { stdout: `${installLocation}\r\n`, stderr: '' });
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
  it('mirrors bundled marketplace, installs local computer-use plugin, refreshes caches, and updates config', async () => {
    await fs.writeFile(paths.config, ['model = "gpt-5"', '', '[features]', 'legacy = true', ''].join('\n'));

    const result = await repairComputerUseCache(paths);
    const configText = await fs.readFile(paths.config, 'utf8');
    const manifest = JSON.parse(await fs.readFile(path.join(result.marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8')) as {
      plugins: Array<{ name: string; source: { path: string } }>;
    };

    expect(result.backupPath).toBeTruthy();
    expect(await fs.readFile(result.backupPath!, 'utf8')).toContain('model = "gpt-5"');
    expect(manifest.plugins[0]).toMatchObject({ name: 'computer-use', source: { path: './plugins/computer-use' } });
    await expect(fs.stat(path.join(result.pluginSourceRoot, '.codex-plugin', 'plugin.json'))).resolves.toBeTruthy();
    await expect(
      fs.stat(
        path.join(
          result.cacheVersionRoot,
          'node_modules',
          '@oai',
          'sky',
          'dist',
          'project',
          'cua',
          'sky_js',
          'src',
          'targets',
          'windows',
          'internal',
          'helper_transport.js'
        )
      )
    ).resolves.toBeTruthy();
    await expect(fs.stat(path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled', 'browser', 'latest'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled', 'chrome', 'latest'))).resolves.toBeTruthy();
    expect(configText).toContain('[marketplaces.openai-bundled]');
    expect(configText).toContain('source_type = "local"');
    expect(configText).toContain('[plugins."computer-use@openai-bundled"]');
    expect(configText).toContain('enabled = true');
    expect(configText).toContain('[windows]');
    expect(configText).toContain('sandbox = "unelevated"');
    expect(configText).toContain('computer_use = true');
    expect(result.environmentEnabled).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-Command', expect.stringContaining('SetEnvironmentVariable')]),
      expect.anything(),
      expect.any(Function)
    );
  });

  it('creates config when it is missing', async () => {
    const result = await repairComputerUseCache(paths);
    const configText = await fs.readFile(paths.config, 'utf8');

    expect(result.backupPath).toBeNull();
    expect(configText).toContain('[marketplaces.openai-bundled]');
    expect(configText).toContain('[plugins."computer-use@openai-bundled"]');
  });
});
