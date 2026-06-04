import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
  await service.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          })
      });
    });
  });
}

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

  it('keeps custom auth unchanged when official auth reuse is disabled', async () => {
    await service.createProfile({
      name: 'openai',
      kind: 'official',
      authJson: { OPENAI_API_KEY: 'official-key', tokens: { access_token: 'official-access' } }
    });
    await service.createProfile({
      name: 'tokenflux',
      kind: 'custom',
      authJson: { OPENAI_API_KEY: 'proxy-key' },
      providerName: 'tokenflux',
      providerBlock: { base_url: 'https://proxy.test/v1', env_key: 'OPENAI_API_KEY' }
    });

    await service.switchProfile('tokenflux');
    const auth = JSON.parse(await fs.readFile(paths.auth, 'utf8'));

    expect(auth).toEqual({ OPENAI_API_KEY: 'proxy-key' });
  });

  it('keeps current auth and writes provider bearer token when official auth reuse is enabled', async () => {
    await fs.writeFile(
      paths.auth,
      JSON.stringify({
        OPENAI_API_KEY: null,
        auth_mode: 'chatgpt',
        tokens: { access_token: 'live-access' }
      })
    );
    await service.createProfile({
      name: 'openai',
      kind: 'official',
      authJson: {
        OPENAI_API_KEY: null,
        auth_mode: 'chatgpt',
        last_refresh: '2026-06-03T06:02:43.055389300Z',
        tokens: {
          access_token: 'official-access',
          refresh_token: 'official-refresh'
        }
      }
    });
    await service.createProfile({
      name: 'tokenflux',
      kind: 'custom',
      authJson: { OPENAI_API_KEY: 'proxy-key' },
      providerName: 'tokenflux',
      providerBlock: { base_url: 'https://proxy.test/v1', env_key: 'OPENAI_API_KEY' }
    });
    await service.updateSettings({
      openAiAuthEnabled: true,
      openAiAuthProfileName: 'openai'
    });

    await service.switchProfile('tokenflux');
    const auth = JSON.parse(await fs.readFile(paths.auth, 'utf8'));
    const config = TOML.parse(await fs.readFile(paths.config, 'utf8'));
    const provider = (config.model_providers as Record<string, Record<string, unknown>>).tokenflux;

    expect(auth.OPENAI_API_KEY).toBeNull();
    expect(auth.auth_mode).toBe('chatgpt');
    expect(auth.tokens).toEqual({ access_token: 'live-access' });
    expect(provider.experimental_bearer_token).toBe('proxy-key');
    expect(provider.requires_openai_auth).toBeUndefined();
  });

  it('rejects enabled official auth reuse without a valid official profile', async () => {
    await service.createProfile({
      name: 'tokenflux',
      kind: 'custom',
      authJson: { OPENAI_API_KEY: 'proxy-key' },
      providerName: 'tokenflux',
      providerBlock: { base_url: 'https://proxy.test/v1', env_key: 'OPENAI_API_KEY' }
    });
    await service.updateSettings({
      openAiAuthEnabled: true,
      openAiAuthProfileName: 'missing'
    });

    await expect(service.switchProfile('tokenflux')).rejects.toThrow(/profile 不存在/);
  });

  it('rejects enabled official auth reuse when selected profile is custom', async () => {
    await service.createProfile({
      name: 'tokenflux',
      kind: 'custom',
      authJson: { OPENAI_API_KEY: 'proxy-key' },
      providerName: 'tokenflux',
      providerBlock: { base_url: 'https://proxy.test/v1', env_key: 'OPENAI_API_KEY' }
    });
    await service.updateSettings({
      openAiAuthEnabled: true,
      openAiAuthProfileName: 'tokenflux'
    });

    await expect(service.switchProfile('tokenflux')).rejects.toThrow(/必须是 Official OpenAI OAuth/);
  });

  it('does not merge configured official auth when switching official profiles', async () => {
    await service.createProfile({
      name: 'openai-a',
      kind: 'official',
      authJson: { OPENAI_API_KEY: 'a-key', tokens: { access_token: 'a-access' } }
    });
    await service.createProfile({
      name: 'openai-b',
      kind: 'official',
      authJson: { OPENAI_API_KEY: 'b-key' }
    });
    await service.updateSettings({
      openAiAuthEnabled: true,
      openAiAuthProfileName: 'openai-a'
    });

    await service.switchProfile('openai-b');
    const auth = JSON.parse(await fs.readFile(paths.auth, 'utf8'));

    expect(auth).toEqual({ OPENAI_API_KEY: 'b-key' });
  });

  it('rewrites base_url to the local proxy when useChatCompletionsProxy is set, and restores on switch-away', async () => {
    const upstream = await startUpstream();
    try {
      await service.createProfile({
        name: 'translated',
        kind: 'custom',
        authJson: { OPENAI_API_KEY: 'upstream-key' },
        providerName: 'translated',
        providerBlock: { base_url: upstream.url, wire_api: 'chat' },
        useChatCompletionsProxy: true
      });
      await service.createProfile({
        name: 'plain',
        kind: 'custom',
        authJson: { OPENAI_API_KEY: 'plain-key' },
        providerName: 'plain',
        providerBlock: { base_url: upstream.url, wire_api: 'responses' }
      });

      await service.switchProfile('translated');
      let config = TOML.parse(await fs.readFile(paths.config, 'utf8'));
      let provider = (config.model_providers as Record<string, Record<string, unknown>>).translated;
      const proxyStatus = service.getProxyStatus();
      expect(proxyStatus.running).toBe(true);
      expect(proxyStatus.profileName).toBe('translated');
      expect(provider.base_url).toBe(`http://127.0.0.1:${proxyStatus.port}/v1`);
      expect(provider.wire_api).toBe('responses');

      await service.switchProfile('plain');
      config = TOML.parse(await fs.readFile(paths.config, 'utf8'));
      provider = (config.model_providers as Record<string, Record<string, unknown>>).plain;
      expect(provider.base_url).toBe(upstream.url);
      expect(service.getProxyStatus()).toEqual({ running: false, port: null, profileName: null });
    } finally {
      await upstream.close();
    }
  });

  it('throws if proxy is requested but base_url or API key is missing', async () => {
    await service.createProfile({
      name: 'bad',
      kind: 'custom',
      authJson: { OPENAI_API_KEY: '' },
      providerName: 'bad',
      providerBlock: { base_url: 'https://example.com/v1' },
      useChatCompletionsProxy: true
    });
    await expect(service.switchProfile('bad')).rejects.toThrow(/OPENAI_API_KEY 为空/);
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
