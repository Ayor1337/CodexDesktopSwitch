import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import TOML from '@iarna/toml';
import { applyProfileToConfig, buildProfileFromCurrent, readConfig } from '../electron/main/codex';
import { createRuntimePaths, type RuntimePaths } from '../electron/main/paths';

let root: string;
let paths: RuntimePaths;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-switch-codex-'));
  paths = createRuntimePaths(path.join(root, 'userData'), root);
  await fs.mkdir(paths.codexDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('codex config handling', () => {
  it('removes model_provider for official profiles and keeps provider tables', () => {
    const parsed = {
      model_provider: 'tokenflux',
      model_providers: {
        tokenflux: { base_url: 'https://proxy.test/v1' }
      },
      model: 'gpt-5'
    };

    applyProfileToConfig(parsed, { name: 'openai', kind: 'official', authJson: {} });

    expect(parsed.model_provider).toBeUndefined();
    expect(parsed.model_providers.tokenflux.base_url).toBe('https://proxy.test/v1');
    expect(parsed.model).toBe('gpt-5');
  });

  it('writes custom provider and model_provider', () => {
    const parsed: Record<string, unknown> = { model: 'gpt-5' };

    applyProfileToConfig(parsed, {
      name: 'proxy',
      kind: 'custom',
      authJson: {},
      providerName: 'tokenflux',
      providerBlock: { base_url: 'https://proxy.test/v1', env_key: 'OPENAI_API_KEY' }
    });

    expect(parsed.model_provider).toBe('tokenflux');
    const provider = (parsed.model_providers as Record<string, Record<string, unknown>>).tokenflux;
    expect(provider.base_url).toBe('https://proxy.test/v1');
    expect(provider.wire_api).toBe('responses');
    expect(provider.requires_openai_auth).toBe(true);
  });

  it('keeps explicit custom provider auth setting', () => {
    const parsed: Record<string, unknown> = { model: 'gpt-5' };

    applyProfileToConfig(parsed, {
      name: 'proxy',
      kind: 'custom',
      authJson: {},
      providerName: 'tokenflux',
      providerBlock: {
        base_url: 'https://proxy.test/v1',
        env_key: 'OPENAI_API_KEY',
        wire_api: 'chat',
        requires_openai_auth: false
      }
    });

    const provider = (parsed.model_providers as Record<string, Record<string, unknown>>).tokenflux;
    expect(provider.wire_api).toBe('chat');
    expect(provider.requires_openai_auth).toBe(false);
  });

  it('writes custom provider bearer token when requested', () => {
    const parsed: Record<string, unknown> = { model: 'gpt-5' };

    applyProfileToConfig(
      parsed,
      {
        name: 'proxy',
        kind: 'custom',
        authJson: { OPENAI_API_KEY: 'proxy-key' },
        providerName: 'tokenflux',
        providerBlock: { base_url: 'https://proxy.test/v1', env_key: 'OPENAI_API_KEY' }
      },
      { embedBearerToken: true }
    );

    const provider = (parsed.model_providers as Record<string, Record<string, unknown>>).tokenflux;
    expect(provider.experimental_bearer_token).toBe('proxy-key');
    expect(provider.wire_api).toBe('responses');
    expect(provider.requires_openai_auth).toBeUndefined();
  });

  it('does not write empty custom provider bearer token', () => {
    const parsed: Record<string, unknown> = { model: 'gpt-5' };

    applyProfileToConfig(
      parsed,
      {
        name: 'proxy',
        kind: 'custom',
        authJson: { OPENAI_API_KEY: '' },
        providerName: 'tokenflux',
        providerBlock: { base_url: 'https://proxy.test/v1', env_key: 'OPENAI_API_KEY' }
      },
      { embedBearerToken: true }
    );

    const provider = (parsed.model_providers as Record<string, Record<string, unknown>>).tokenflux;
    expect(provider.experimental_bearer_token).toBeUndefined();
  });

  it('imports current official profile', async () => {
    await fs.writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
    await fs.writeFile(paths.config, TOML.stringify({ model: 'gpt-5' }));

    const profile = await buildProfileFromCurrent(paths, 'current');

    expect(profile.kind).toBe('official');
    expect(profile.authJson.OPENAI_API_KEY).toBe('sk-test');
  });

  it('imports current custom provider profile', async () => {
    await fs.writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
    await fs.writeFile(
      paths.config,
      TOML.stringify({
        model_provider: 'ollama',
        model_providers: { ollama: { base_url: 'http://localhost:11434/v1', env_key: 'OPENAI_API_KEY' } }
      })
    );

    const profile = await buildProfileFromCurrent(paths, 'ollama-local');

    expect(profile.kind).toBe('custom');
    expect(profile.providerName).toBe('ollama');
    expect(profile.providerBlock?.base_url).toBe('http://localhost:11434/v1');
  });

  it('returns empty config when config.toml is missing', async () => {
    const config = await readConfig(paths);

    expect(config.parsed).toEqual({});
    expect(config.mode).toBe(0o600);
  });
});
