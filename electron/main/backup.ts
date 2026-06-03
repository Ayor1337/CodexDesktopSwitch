import fs from 'node:fs/promises';
import path from 'node:path';
import type { BackupEntry } from '../../src/types';
import type { RuntimePaths } from './paths';
import { writeFileAtomic } from './atomic';

const META = 'backup.json';

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listBackups(paths: RuntimePaths): Promise<BackupEntry[]> {
  try {
    const entries = await fs.readdir(paths.backups, { withFileTypes: true });
    const backups = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const metaPath = path.join(paths.backups, entry.name, META);
          const raw = await fs.readFile(metaPath, 'utf8');
          return JSON.parse(raw) as BackupEntry;
        })
    );
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function backupOnceIfNeeded(paths: RuntimePaths): Promise<boolean> {
  const backups = await listBackups(paths);
  if (backups.length > 0) return false;

  const createdAt = new Date().toISOString();
  const id = createdAt.replace(/[:.]/g, '-');
  const backupDir = path.join(paths.backups, id);
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });

  const files: BackupEntry['files'] = {};
  if (await exists(paths.auth)) {
    files.auth = 'auth.json';
    await fs.copyFile(paths.auth, path.join(backupDir, files.auth));
  }
  if (await exists(paths.config)) {
    files.config = 'config.toml';
    await fs.copyFile(paths.config, path.join(backupDir, files.config));
  }

  const entry: BackupEntry = { id, createdAt, files };
  await writeFileAtomic(path.join(backupDir, META), `${JSON.stringify(entry, null, 2)}\n`, 0o600);
  return true;
}

export async function restoreBackup(paths: RuntimePaths, backupId: string): Promise<void> {
  const backups = await listBackups(paths);
  const backup = backups.find((entry) => entry.id === backupId);
  if (!backup) throw new Error(`备份不存在：${backupId}`);

  if (backup.files.auth) {
    await fs.mkdir(path.dirname(paths.auth), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(paths.backups, backup.id, backup.files.auth), paths.auth);
  }
  if (backup.files.config) {
    await fs.mkdir(path.dirname(paths.config), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(paths.backups, backup.id, backup.files.config), paths.config);
  }
}
