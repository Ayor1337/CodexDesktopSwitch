import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import TOML from '@iarna/toml';
import { createRuntimePaths, type RuntimePaths } from '../electron/main/paths';
import { CodexSwitchService } from '../electron/main/service';

let root: string;
let paths: RuntimePaths;
let service: CodexSwitchService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-switch-service-'));
  paths = createRuntimePaths(path.join(root, 'userData'), root);
  service = new CodexSwitchService(paths);
  await fs.mkdir(paths.codexDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('CodexSwitchService', () => {
  it('switches official profile and creates one-time backup', async () => {
    await fs.writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: 'old' }));
    await fs.writeFile(
      paths.config,
      TOML.stringify({
        model_provider: 'tokenflux',
        model_providers: { tokenflux: { base_url: 'https://proxy.test/v1' } },
        model: 'gpt-5'
      })
    );
    await service.createProfile({ name: 'openai', kind: 'official', authJson: { OPENAI_API_KEY: 'new' } });

    const result = await service.switchProfile('openai');
    const config = TOML.parse(await fs.readFile(paths.config, 'utf8'));
    const auth = JSON.parse(await fs.readFile(paths.auth, 'utf8'));
    const backups = await service.listBackups();

    expect(result.didBackup).toBe(true);
    expect(config.model_provider).toBeUndefined();
    expect((config.model_providers as Record<string, Record<string, string>>).tokenflux.base_url).toBe('https://proxy.test/v1');
    expect(auth.OPENAI_API_KEY).toBe('new');
    expect(backups).toHaveLength(1);
  });

  it('switches custom provider and detects active profile', async () => {
    await service.createProfile({
      name: 'tokenflux',
      kind: 'custom',
      authJson: { OPENAI_API_KEY: 'proxy-key' },
      providerName: 'tokenflux',
      providerBlock: { base_url: 'https://proxy.test/v1', env_key: 'OPENAI_API_KEY' }
    });

    await service.switchProfile('tokenflux');

    expect(await service.detectActiveProfile()).toBe('tokenflux');
  });

  it('restores latest backup', async () => {
    await fs.writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: 'old' }));
    await fs.writeFile(paths.config, TOML.stringify({ model: 'old-model' }));
    await service.createProfile({ name: 'openai', kind: 'official', authJson: { OPENAI_API_KEY: 'new' } });
    await service.switchProfile('openai');
    const [backup] = await service.listBackups();

    await fs.writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: 'changed' }));
    await service.restoreBackup(backup.id);
    const auth = JSON.parse(await fs.readFile(paths.auth, 'utf8'));

    expect(auth.OPENAI_API_KEY).toBe('old');
  });
});
