import os from 'node:os';
import path from 'node:path';

export interface RuntimePaths {
  codexDir: string;
  auth: string;
  config: string;
  userData: string;
  profiles: string;
  settings: string;
  backups: string;
}

export function createRuntimePaths(userData: string, home = os.homedir()): RuntimePaths {
  const codexDir = path.join(home, '.codex');
  return {
    codexDir,
    auth: path.join(codexDir, 'auth.json'),
    config: path.join(codexDir, 'config.toml'),
    userData,
    profiles: path.join(userData, 'profiles.json'),
    settings: path.join(userData, 'settings.json'),
    backups: path.join(userData, 'backups')
  };
}
