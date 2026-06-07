import type { ActiveProfileDetection, AppSettings, Profile, ProfileInput, ProfileState, ProxyStatus, SwitchResult } from '../../src/types';
import type { RuntimePaths } from './paths';
import { addProfile, deleteProfile, findProfile, profileKind, renameProfile, sameProfileState, updateProfile } from './profiles';
import { loadProfiles, saveProfiles } from './store';
import { applyProfileToConfig, buildProfileFromCurrent, extractCurrent, readConfig, readCurrentCodex, writeAuth, writeConfig } from './codex';
import { backupOnceIfNeeded, listBackups, restoreBackup } from './backup';
import { loadSettings, updateSettings } from './settings';
import { deepEqual } from './deepEqual';
import { getProxyStatus, startProxy, stopProxy } from './proxy';
import { repairComputerUseCache } from './computerUseCache';

export class CodexSwitchService {
  constructor(private readonly paths: RuntimePaths) {}

  async listProfiles(): Promise<ProfileState> {
    return loadProfiles(this.paths);
  }

  async createProfile(input: ProfileInput): Promise<ProfileState> {
    const state = await loadProfiles(this.paths);
    addProfile(state, input);
    await saveProfiles(this.paths, state);
    return state;
  }

  async updateProfile(name: string, patch: Partial<ProfileInput>): Promise<ProfileState> {
    const state = await loadProfiles(this.paths);
    updateProfile(state, name, patch);
    await saveProfiles(this.paths, state);
    return state;
  }

  async deleteProfile(name: string): Promise<ProfileState> {
    const state = await loadProfiles(this.paths);
    deleteProfile(state, name);
    await saveProfiles(this.paths, state);
    return state;
  }

  async renameProfile(oldName: string, newName: string): Promise<ProfileState> {
    const state = await loadProfiles(this.paths);
    renameProfile(state, oldName, newName);
    await saveProfiles(this.paths, state);
    return state;
  }

  async importCurrent(name: string): Promise<ProfileState> {
    const state = await loadProfiles(this.paths);
    addProfile(state, await buildProfileFromCurrent(this.paths, name));
    await saveProfiles(this.paths, state);
    return state;
  }

  async syncCurrentOfficialAuthProfile(name: string): Promise<ProfileState> {
    const state = await loadProfiles(this.paths);
    this.syncCurrentOfficialAuthIntoProfile(state, name, await readCurrentCodex(this.paths));
    await saveProfiles(this.paths, state);
    return state;
  }

  async switchProfile(name: string): Promise<SwitchResult> {
    const state = await loadProfiles(this.paths);
    const profile = findProfile(state, name);
    if (!profile) throw new Error(`Profile 不存在：${name}`);
    const authSync = await this.syncCurrentOfficialAuth(state);
    const switchPlan = await this.buildSwitchPlan(state, profile);

    const didBackup = await backupOnceIfNeeded(this.paths);

    const baseUrlOverride = await this.refreshProxy(profile);

    const config = await readConfig(this.paths);
    applyProfileToConfig(config.parsed, profile, {
      embedBearerToken: switchPlan.embedBearerToken,
      baseUrlOverride
    });
    await writeConfig(this.paths, config.parsed, config.mode);
    if (switchPlan.writeAuth) await writeAuth(this.paths, profile.authJson);

    state.active = name;
    await saveProfiles(this.paths, state);
    return { didBackup, ...authSync };
  }

  async restoreActiveProxy(): Promise<void> {
    const state = await loadProfiles(this.paths);
    if (!state.active) return;
    const profile = findProfile(state, state.active);
    if (!profile) return;
    await this.refreshProxy(profile);
  }

  getProxyStatus(): ProxyStatus {
    return getProxyStatus();
  }

  async repairComputerUseCache() {
    return repairComputerUseCache(this.paths);
  }

  async shutdown(): Promise<void> {
    await stopProxy();
  }

  private async refreshProxy(profile: Profile): Promise<string | undefined> {
    if (profileKind(profile) !== 'custom' || !profile.useChatCompletionsProxy) {
      await stopProxy();
      return undefined;
    }
    const upstreamBaseUrl =
      typeof profile.providerBlock?.base_url === 'string' ? (profile.providerBlock.base_url as string) : '';
    if (!upstreamBaseUrl) {
      throw new Error(`Profile ${profile.name} 启用了翻译代理但 providerBlock.base_url 为空`);
    }
    const apiKey =
      typeof profile.authJson.OPENAI_API_KEY === 'string' ? (profile.authJson.OPENAI_API_KEY as string) : '';
    if (!apiKey) {
      throw new Error(`Profile ${profile.name} 启用了翻译代理但 authJson.OPENAI_API_KEY 为空`);
    }
    const { port } = await startProxy({ upstreamBaseUrl, apiKey, profileName: profile.name });
    return `http://127.0.0.1:${port}/v1`;
  }

  async getSettings(): Promise<AppSettings> {
    return loadSettings(this.paths);
  }

  async updateSettings(patch: Partial<Omit<AppSettings, 'version'>>): Promise<AppSettings> {
    return updateSettings(this.paths, patch);
  }

  private async buildSwitchPlan(state: ProfileState, profile: Profile): Promise<{ embedBearerToken: boolean; writeAuth: boolean }> {
    if (profileKind(profile) === 'official') return { embedBearerToken: false, writeAuth: true };

    const settings = await loadSettings(this.paths);
    if (!settings.openAiAuthEnabled) return { embedBearerToken: false, writeAuth: true };
    if (!settings.openAiAuthProfileName) throw new Error('已启用 OpenAI 官方账号验证，但未选择 Official OpenAI OAuth profile');

    const officialProfile = findProfile(state, settings.openAiAuthProfileName);
    if (!officialProfile) throw new Error(`OpenAI 官方账号验证 profile 不存在：${settings.openAiAuthProfileName}`);
    if (profileKind(officialProfile) !== 'official') {
      throw new Error(`OpenAI 官方账号验证 profile 必须是 Official OpenAI OAuth：${settings.openAiAuthProfileName}`);
    }

    return { embedBearerToken: true, writeAuth: false };
  }

  private async syncCurrentOfficialAuth(
    state: ProfileState
  ): Promise<Pick<SwitchResult, 'syncedOfficialAuthProfileName' | 'officialAuthSyncSkipped'>> {
    const current = await readCurrentCodex(this.paths);
    if (!current.authJson || current.providerName) return {};

    let profileName: string | null = null;
    if (state.active && profileKind(findProfile(state, state.active) || {}) === 'official') {
      profileName = state.active;
    } else {
      const matches = state.profiles.filter(
        (candidate) => profileKind(candidate) === 'official' && sameProfileState(candidate, current.authJson!, null, null)
      );
      if (matches.length === 1) profileName = matches[0].name;
    }

    if (!profileName) return { officialAuthSyncSkipped: true };

    this.syncCurrentOfficialAuthIntoProfile(state, profileName, current);
    return { syncedOfficialAuthProfileName: profileName };
  }

  private syncCurrentOfficialAuthIntoProfile(state: ProfileState, name: string, current: Awaited<ReturnType<typeof readCurrentCodex>>): void {
    if (!current.authJson) throw new Error('当前 ~/.codex/auth.json 不存在');
    if (current.providerName) throw new Error('当前 Codex 配置不是 Official OpenAI OAuth 通道');
    const profile = findProfile(state, name);
    if (!profile) throw new Error(`Profile 不存在：${name}`);
    if (profileKind(profile) !== 'official') throw new Error(`Profile 不是 Official OpenAI OAuth：${name}`);
    profile.authJson = current.authJson;
    profile.updatedAt = new Date().toISOString();
  }

  async readCurrent() {
    return readCurrentCodex(this.paths);
  }

  async detectActiveProfile(): Promise<ActiveProfileDetection> {
    const state = await loadProfiles(this.paths);
    const current = await readCurrentCodex(this.paths);
    if (!current.authJson) return { status: 'none', profileName: null };
    const config = await readConfig(this.paths);
    const detected = extractCurrent(config.parsed);
    const activeProfile = state.active ? findProfile(state, state.active) : null;
    if (!detected.providerName && activeProfile && profileKind(activeProfile) === 'official') {
      return sameProfileState(activeProfile, current.authJson, null, null)
        ? { status: 'sync', profileName: activeProfile.name, kind: 'official' }
        : { status: 'not_sync', profileName: activeProfile.name, kind: 'official' };
    }
    const settings = await loadSettings(this.paths);
    const proxyStatus = getProxyStatus();
    const profile = state.profiles.find((candidate) => {
      if (profileKind(candidate) === 'official') {
        return sameProfileState(candidate, current.authJson!, detected.providerName, detected.providerBlock);
      }
      if (detected.providerName !== candidate.providerName) return false;
      if (!settings.openAiAuthEnabled && !deepEqual(candidate.authJson, current.authJson)) return false;
      const baseUrlOverride =
        candidate.useChatCompletionsProxy && proxyStatus.running && proxyStatus.profileName === candidate.name
          ? `http://127.0.0.1:${proxyStatus.port}/v1`
          : undefined;
      const expected: Record<string, unknown> = {};
      applyProfileToConfig(expected, candidate, {
        embedBearerToken: settings.openAiAuthEnabled,
        baseUrlOverride
      });
      return deepEqual(extractCurrent(expected).providerBlock, detected.providerBlock);
    });
    return profile ? { status: 'sync', profileName: profile.name, kind: profileKind(profile) } : { status: 'none', profileName: null };
  }

  async listBackups() {
    return listBackups(this.paths);
  }

  async restoreBackup(backupId: string): Promise<void> {
    await restoreBackup(this.paths, backupId);
  }
}
