import type { ProfileInput, ProfileState, SwitchResult } from '../../src/types';
import type { RuntimePaths } from './paths';
import { addProfile, deleteProfile, findProfile, renameProfile, sameProfileState, updateProfile } from './profiles';
import { loadProfiles, saveProfiles } from './store';
import { applyProfileToConfig, buildProfileFromCurrent, extractCurrent, readConfig, readCurrentCodex, writeAuth, writeConfig } from './codex';
import { backupOnceIfNeeded, listBackups, restoreBackup } from './backup';

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

  async switchProfile(name: string): Promise<SwitchResult> {
    const state = await loadProfiles(this.paths);
    const profile = findProfile(state, name);
    if (!profile) throw new Error(`Profile 不存在：${name}`);

    const didBackup = await backupOnceIfNeeded(this.paths);
    const config = await readConfig(this.paths);
    applyProfileToConfig(config.parsed, profile);
    await writeConfig(this.paths, config.parsed, config.mode);
    await writeAuth(this.paths, profile.authJson);

    state.active = name;
    await saveProfiles(this.paths, state);
    return { didBackup };
  }

  async readCurrent() {
    return readCurrentCodex(this.paths);
  }

  async detectActiveProfile(): Promise<string | null> {
    const state = await loadProfiles(this.paths);
    const current = await readCurrentCodex(this.paths);
    if (!current.authJson) return null;
    const config = await readConfig(this.paths);
    const detected = extractCurrent(config.parsed);
    const profile = state.profiles.find((candidate) =>
      sameProfileState(candidate, current.authJson!, detected.providerName, detected.providerBlock)
    );
    return profile?.name || null;
  }

  async listBackups() {
    return listBackups(this.paths);
  }

  async restoreBackup(backupId: string): Promise<void> {
    await restoreBackup(this.paths, backupId);
  }
}
