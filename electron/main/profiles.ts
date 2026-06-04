import type { AuthJson, Profile, ProfileInput, ProfileKind, ProfileState } from '../../src/types';
import { deepEqual } from './deepEqual';

export const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function validateName(name: string): void {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Profile 名称无效：${name}。仅允许字母、数字、_、.、-`);
  }
}

export function profileKind(profile: Partial<ProfileInput>): ProfileKind {
  if (profile.kind === 'official' || profile.kind === 'custom') return profile.kind;
  return profile.providerName ? 'custom' : 'official';
}

export function validateProfileInput(input: ProfileInput): void {
  validateName(input.name);
  if (!input.authJson || typeof input.authJson !== 'object' || Array.isArray(input.authJson)) {
    throw new Error('authJson 必须是 JSON 对象');
  }
  if (input.kind === 'custom') {
    validateName(input.providerName || '');
    if (!input.providerBlock || typeof input.providerBlock !== 'object' || Array.isArray(input.providerBlock)) {
      throw new Error('自定义 profile 必须包含 providerBlock 对象');
    }
  }
  if (input.useChatCompletionsProxy !== undefined && typeof input.useChatCompletionsProxy !== 'boolean') {
    throw new Error('useChatCompletionsProxy 必须是布尔值');
  }
}

export function emptyState(): ProfileState {
  return { version: 1, active: null, profiles: [] };
}

export function findProfile(state: ProfileState, name: string): Profile | null {
  return state.profiles.find((profile) => profile.name === name) || null;
}

export function addProfile(state: ProfileState, input: ProfileInput): ProfileState {
  validateProfileInput(input);
  if (findProfile(state, input.name)) throw new Error(`Profile 已存在：${input.name}`);
  const now = new Date().toISOString();
  state.profiles.push({ ...input, createdAt: now, updatedAt: now });
  return state;
}

export function updateProfile(state: ProfileState, name: string, patch: Partial<ProfileInput>): ProfileState {
  const profile = findProfile(state, name);
  if (!profile) throw new Error(`Profile 不存在：${name}`);
  const next = { ...profile, ...patch, name: patch.name || profile.name } as ProfileInput;
  validateProfileInput(next);
  Object.assign(profile, patch, { updatedAt: new Date().toISOString() });
  return state;
}

export function renameProfile(state: ProfileState, oldName: string, newName: string): ProfileState {
  validateName(newName);
  if (findProfile(state, newName)) throw new Error(`Profile 已存在：${newName}`);
  const profile = findProfile(state, oldName);
  if (!profile) throw new Error(`Profile 不存在：${oldName}`);
  profile.name = newName;
  profile.updatedAt = new Date().toISOString();
  if (state.active === oldName) state.active = newName;
  return state;
}

export function deleteProfile(state: ProfileState, name: string): ProfileState {
  const index = state.profiles.findIndex((profile) => profile.name === name);
  if (index < 0) throw new Error(`Profile 不存在：${name}`);
  state.profiles.splice(index, 1);
  if (state.active === name) state.active = null;
  return state;
}

export function maskAuth(authJson: AuthJson): AuthJson {
  const result: AuthJson = {};
  for (const [key, value] of Object.entries(authJson)) {
    if (/key|token|secret/i.test(key) && typeof value === 'string') {
      result[key] = value.length <= 8 ? '****' : `${value.slice(0, 3)}...${value.slice(-4)}`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function sameProfileState(profile: Profile, authJson: AuthJson, providerName: string | null, providerBlock: unknown): boolean {
  if (!deepEqual(profile.authJson, authJson)) return false;
  if (profileKind(profile) === 'official') return providerName === null;
  return profile.providerName === providerName && deepEqual(profile.providerBlock, providerBlock);
}
