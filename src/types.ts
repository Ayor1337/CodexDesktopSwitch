export type ProfileKind = 'official' | 'custom';
export type CloseBehavior = 'quit' | 'minimizeToTray';
export type ThemeMode = 'light' | 'dark' | 'system';

export type AuthJson = Record<string, unknown>;
export type ProviderBlock = Record<string, unknown>;

export interface Profile {
  name: string;
  kind: ProfileKind;
  authJson: AuthJson;
  providerName?: string;
  providerBlock?: ProviderBlock;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileInput {
  name: string;
  kind: ProfileKind;
  authJson: AuthJson;
  providerName?: string;
  providerBlock?: ProviderBlock;
}

export interface ProfileState {
  version: 1;
  active: string | null;
  profiles: Profile[];
}

export interface AppSettings {
  version: 1;
  launchAtLogin: boolean;
  silentStartup: boolean;
  closeBehavior: CloseBehavior;
  themeMode: ThemeMode;
  openAiAuthEnabled: boolean;
  openAiAuthProfileName: string | null;
}

export interface CurrentCodexState {
  authJson: AuthJson | null;
  config: Record<string, unknown>;
  providerName: string | null;
  providerBlock: ProviderBlock | null;
  paths: {
    auth: string;
    config: string;
  };
}

export interface BackupEntry {
  id: string;
  createdAt: string;
  files: {
    auth?: string;
    config?: string;
  };
}

export interface SwitchResult {
  didBackup: boolean;
}

export interface RestartCodexResult {
  killed: string[];
  started: boolean;
  executablePath: string | null;
}

export interface AppApi {
  profiles: {
    list: () => Promise<ProfileState>;
    create: (profile: ProfileInput) => Promise<ProfileState>;
    update: (name: string, patch: Partial<ProfileInput>) => Promise<ProfileState>;
    delete: (name: string) => Promise<ProfileState>;
    rename: (oldName: string, newName: string) => Promise<ProfileState>;
    importCurrent: (name: string) => Promise<ProfileState>;
    switch: (name: string) => Promise<SwitchResult>;
  };
  codex: {
    readCurrent: () => Promise<CurrentCodexState>;
    detectActiveProfile: () => Promise<string | null>;
    parseToml: (text: string) => Promise<ProviderBlock>;
    stringifyToml: (value: ProviderBlock) => Promise<string>;
    restart: () => Promise<RestartCodexResult>;
  };
  backup: {
    list: () => Promise<BackupEntry[]>;
    restore: (backupId: string) => Promise<void>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (patch: Partial<Omit<AppSettings, 'version'>>) => Promise<AppSettings>;
  };
}

declare global {
  interface Window {
    codexSwitch: AppApi;
  }
}
