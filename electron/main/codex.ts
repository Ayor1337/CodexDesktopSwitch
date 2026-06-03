import fs from 'node:fs/promises';
import TOML from '@iarna/toml';
import type { AuthJson, CurrentCodexState, Profile, ProfileInput, ProviderBlock } from '../../src/types';
import { writeFileAtomic } from './atomic';
import type { RuntimePaths } from './paths';
import { profileKind, validateName } from './profiles';

export async function readAuth(paths: RuntimePaths): Promise<AuthJson | null> {
  try {
    const raw = await fs.readFile(paths.auth, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('auth.json 必须是 JSON 对象');
    return parsed as AuthJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readConfig(paths: RuntimePaths): Promise<{ raw: string; parsed: Record<string, unknown>; mode: number }> {
  try {
    const raw = await fs.readFile(paths.config, 'utf8');
    const stat = await fs.stat(paths.config);
    return { raw, parsed: TOML.parse(raw), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: '', parsed: {}, mode: 0o600 };
    throw error;
  }
}

export function extractCurrent(parsed: Record<string, unknown>): { providerName: string | null; providerBlock: ProviderBlock | null } {
  const providerName = typeof parsed.model_provider === 'string' && parsed.model_provider.length > 0 ? parsed.model_provider : null;
  const providers = parsed.model_providers;
  if (!providerName || !providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return { providerName, providerBlock: null };
  }
  const providerBlock = (providers as Record<string, unknown>)[providerName];
  return {
    providerName,
    providerBlock: providerBlock && typeof providerBlock === 'object' && !Array.isArray(providerBlock) ? (providerBlock as ProviderBlock) : null
  };
}

export function applyProfileToConfig(parsed: Record<string, unknown>, profile: Profile | ProfileInput): Record<string, unknown> {
  if (profileKind(profile) === 'official') {
    delete parsed.model_provider;
    return parsed;
  }

  if (!profile.providerName) throw new Error('自定义 profile 缺少 providerName');
  validateName(profile.providerName);
  if (!profile.providerBlock || typeof profile.providerBlock !== 'object' || Array.isArray(profile.providerBlock)) {
    throw new Error('自定义 profile 缺少有效 providerBlock');
  }

  parsed.model_provider = profile.providerName;
  if (!parsed.model_providers || typeof parsed.model_providers !== 'object' || Array.isArray(parsed.model_providers)) {
    parsed.model_providers = {};
  }
  (parsed.model_providers as Record<string, unknown>)[profile.providerName] = { ...profile.providerBlock };
  return parsed;
}

export async function writeAuth(paths: RuntimePaths, authJson: AuthJson): Promise<void> {
  await writeFileAtomic(paths.auth, `${JSON.stringify(authJson, null, 2)}\n`, 0o600);
}

export async function writeConfig(paths: RuntimePaths, parsed: Record<string, unknown>, mode = 0o600): Promise<void> {
  await writeFileAtomic(paths.config, TOML.stringify(parsed), mode);
}

export async function readCurrentCodex(paths: RuntimePaths): Promise<CurrentCodexState> {
  const [authJson, configData] = await Promise.all([readAuth(paths), readConfig(paths)]);
  const current = extractCurrent(configData.parsed);
  return {
    authJson,
    config: configData.parsed,
    providerName: current.providerName,
    providerBlock: current.providerBlock,
    paths: {
      auth: paths.auth,
      config: paths.config
    }
  };
}

export async function buildProfileFromCurrent(paths: RuntimePaths, name: string): Promise<ProfileInput> {
  validateName(name);
  const current = await readCurrentCodex(paths);
  if (!current.authJson) throw new Error('当前 ~/.codex/auth.json 不存在');
  if (!current.providerName) {
    return { name, kind: 'official', authJson: current.authJson };
  }
  if (!current.providerBlock) {
    throw new Error(`config.toml 设置了 model_provider="${current.providerName}"，但没有对应 provider 表`);
  }
  return {
    name,
    kind: 'custom',
    authJson: current.authJson,
    providerName: current.providerName,
    providerBlock: current.providerBlock
  };
}
