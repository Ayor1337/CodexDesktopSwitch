import fs from 'node:fs/promises';
import type { ProfileState } from '../../src/types';
import { writeFileAtomic } from './atomic';
import { emptyState } from './profiles';
import type { RuntimePaths } from './paths';

export async function loadProfiles(paths: RuntimePaths): Promise<ProfileState> {
  try {
    const raw = await fs.readFile(paths.profiles, 'utf8');
    const state = JSON.parse(raw) as ProfileState;
    if (state.version !== 1 || !Array.isArray(state.profiles)) {
      throw new Error(`profiles.json 结构无效：${paths.profiles}`);
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function saveProfiles(paths: RuntimePaths, state: ProfileState): Promise<void> {
  await writeFileAtomic(paths.profiles, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
