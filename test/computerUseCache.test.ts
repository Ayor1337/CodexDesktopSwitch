import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repairComputerUseCache } from '../electron/main/computerUseCache';
import { createRuntimePaths, type RuntimePaths } from '../electron/main/paths';

let root: string;
let paths: RuntimePaths;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-switch-computer-use-'));
  paths = createRuntimePaths(path.join(root, 'userData'), root);
  await fs.mkdir(paths.codexDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('repairComputerUseCache', () => {
  it('backs up config, disables bundled plugins, and renames plugin caches', async () => {
    await fs.writeFile(
      paths.config,
      [
        'js_repl = false',
        'sandbox = "elevated"',
        '',
        '[marketplaces.openai-bundled]',
        'source = "old"',
        '',
        '[plugins."browser@openai-bundled"]',
        'enabled = true',
        '',
        '[plugins."chrome@openai-bundled"]',
        'enabled = true',
        '',
        '[plugins."computer-use@openai-bundled"]',
        'enabled = true',
        ''
      ].join('\n')
    );
    const cachePath = path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled');
    const marketplaceCachePath = path.join(paths.codexDir, '.tmp', 'bundled-marketplaces', 'openai-bundled');
    await fs.mkdir(cachePath, { recursive: true });
    await fs.mkdir(marketplaceCachePath, { recursive: true });

    const result = await repairComputerUseCache(paths);
    const configText = await fs.readFile(paths.config, 'utf8');
    const backupText = await fs.readFile(result.backupPath, 'utf8');

    expect(backupText).toContain('[marketplaces.openai-bundled]');
    expect(configText).not.toContain('[marketplaces.openai-bundled]');
    expect(configText).toContain('js_repl = true');
    expect(configText).toContain('sandbox = "unelevated"');
    expect(configText).toMatch(/\[plugins\."browser@openai-bundled"\]\s+enabled = false/);
    expect(configText).toMatch(/\[plugins\."chrome@openai-bundled"\]\s+enabled = false/);
    expect(configText).toMatch(/\[plugins\."computer-use@openai-bundled"\]\s+enabled = false/);
    expect(result.renamedPaths).toHaveLength(2);
    await expect(fs.stat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(marketplaceCachePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adds disabled bundled plugin blocks when missing', async () => {
    await fs.writeFile(paths.config, 'model = "gpt-5"\n');

    await repairComputerUseCache(paths);
    const configText = await fs.readFile(paths.config, 'utf8');

    expect(configText).toMatch(/\[plugins\."browser@openai-bundled"\]\s+enabled = false/);
    expect(configText).toMatch(/\[plugins\."chrome@openai-bundled"\]\s+enabled = false/);
    expect(configText).toMatch(/\[plugins\."computer-use@openai-bundled"\]\s+enabled = false/);
  });
});
