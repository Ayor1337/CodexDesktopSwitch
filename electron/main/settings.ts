import fs from 'node:fs/promises';
import type { AppSettings } from '../../src/types';
import { writeFileAtomic } from './atomic';
import type { RuntimePaths } from './paths';

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  launchAtLogin: false,
  silentStartup: false,
  openAiAuthEnabled: false,
  openAiAuthProfileName: null
};

function normalizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('settings.json 必须是 JSON 对象');
  }
  const source = value as Partial<AppSettings>;
  if (source.version !== 1) throw new Error('settings.json 版本无效');
  return {
    version: 1,
    launchAtLogin: source.launchAtLogin === true,
    silentStartup: source.silentStartup === true,
    openAiAuthEnabled: source.openAiAuthEnabled === true,
    openAiAuthProfileName:
      typeof source.openAiAuthProfileName === 'string' && source.openAiAuthProfileName.length > 0
        ? source.openAiAuthProfileName
        : null
  };
}

export async function loadSettings(paths: RuntimePaths): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(paths.settings, 'utf8');
    return normalizeSettings(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw error;
  }
}

export async function saveSettings(paths: RuntimePaths, settings: AppSettings): Promise<void> {
  await writeFileAtomic(paths.settings, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
}

export async function updateSettings(
  paths: RuntimePaths,
  patch: Partial<Omit<AppSettings, 'version'>>
): Promise<AppSettings> {
  const current = await loadSettings(paths);
  const next = normalizeSettings({ ...current, ...patch, version: 1 });
  await saveSettings(paths, next);
  return next;
}
