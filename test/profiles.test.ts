import { describe, expect, it } from 'vitest';
import { addProfile, emptyState, renameProfile, updateProfile, validateName } from '../electron/main/profiles';

describe('profiles', () => {
  it('validates names', () => {
    expect(() => validateName('official-openai_1.2')).not.toThrow();
    expect(() => validateName('bad name')).toThrow(/Profile 名称无效/);
  });

  it('adds and renames profiles', () => {
    const state = emptyState();
    addProfile(state, { name: 'openai', kind: 'official', authJson: { OPENAI_API_KEY: 'sk-test' } });
    state.active = 'openai';

    renameProfile(state, 'openai', 'official-openai');

    expect(state.profiles[0].name).toBe('official-openai');
    expect(state.active).toBe('official-openai');
  });

  it('requires provider block for custom profiles', () => {
    const state = emptyState();

    expect(() =>
      addProfile(state, {
        name: 'proxy',
        kind: 'custom',
        authJson: { OPENAI_API_KEY: 'key' },
        providerName: 'proxy'
      })
    ).toThrow(/providerBlock/);
  });

  it('validates updated profile shape before persisting patch', () => {
    const state = emptyState();
    addProfile(state, { name: 'openai', kind: 'official', authJson: { OPENAI_API_KEY: 'sk-test' } });

    expect(() => updateProfile(state, 'openai', { kind: 'custom' })).toThrow(/providerName|名称无效/);
  });
});
