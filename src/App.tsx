import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  CheckCircle2,
  Download,
  FileJson,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Zap
} from 'lucide-react';
import type { CurrentCodexState, Profile, ProfileInput, ProfileState } from './types';

type Tab = 'account' | 'providers';
type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null;
type NameDialog =
  | { kind: 'import'; title: string; value: string }
  | { kind: 'rename'; title: string; value: string; originalName: string };
type SwitchDialog = { profileName: string } | null;

const emptyProfile: ProfileInput = {
  name: '',
  kind: 'official',
  authJson: { OPENAI_API_KEY: '' },
  providerName: '',
  providerBlock: {}
};

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readPath(source: Record<string, unknown> | null, path: string[]): string {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return '';
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : '';
}

function writePath(source: Record<string, unknown>, path: string[], value: string): Record<string, unknown> {
  const next = structuredClone(source);
  let cursor = next;
  for (const key of path.slice(0, -1)) {
    const child = cursor[key];
    if (!child || typeof child !== 'object' || Array.isArray(child)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
  return next;
}

function maskValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  if (value.length === 0) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isSecretKey(key: string): boolean {
  return /key|token|secret/i.test(key);
}

function maskSecrets(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, parentKey));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSecretKey(key) || isSecretKey(parentKey) ? maskValue(child) : maskSecrets(child, key);
    }
    return result;
  }
  return isSecretKey(parentKey) ? maskValue(value) : value;
}

function describeAuth(authJson: Record<string, unknown>): string {
  if (typeof authJson.OPENAI_API_KEY === 'string' && authJson.OPENAI_API_KEY) return 'API Key';
  if (authJson.tokens && typeof authJson.tokens === 'object') return 'OAuth Tokens';
  return '自定义 JSON';
}

function createDraft(profile?: Profile): ProfileInput {
  if (!profile) return { ...emptyProfile, authJson: { ...emptyProfile.authJson }, providerBlock: {} };
  return {
    name: profile.name,
    kind: profile.kind,
    authJson: profile.authJson,
    providerName: profile.providerName || '',
    providerBlock: profile.providerBlock || {}
  };
}

export function App(): JSX.Element {
  const [state, setState] = useState<ProfileState>({ version: 1, active: null, profiles: [] });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [activeDetected, setActiveDetected] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentCodexState | null>(null);
  const [tab, setTab] = useState<Tab>('account');
  const [notice, setNotice] = useState<Notice>(null);
  const [draft, setDraft] = useState<ProfileInput>(() => createDraft());
  const [authText, setAuthText] = useState(stringifyJson(emptyProfile.authJson));
  const [providerText, setProviderText] = useState('');
  const [isNew, setIsNew] = useState(true);
  const [busy, setBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [switchDialog, setSwitchDialog] = useState<SwitchDialog>(null);
  const [authEditorOpen, setAuthEditorOpen] = useState(false);
  const [providerEditorOpen, setProviderEditorOpen] = useState(false);
  const [providerParseError, setProviderParseError] = useState<string | null>(null);
  const [focusedSecretPath, setFocusedSecretPath] = useState<string | null>(null);

  const selected = useMemo(
    () => state.profiles.find((profile) => profile.name === selectedName) || state.profiles[0] || null,
    [selectedName, state.profiles]
  );

  async function refresh(): Promise<void> {
    const [profiles, codexState, detected] = await Promise.all([
      window.codexSwitch.profiles.list(),
      window.codexSwitch.codex.readCurrent(),
      window.codexSwitch.codex.detectActiveProfile()
    ]);
    setState(profiles);
    setCurrent(codexState);
    setActiveDetected(detected);
    setSelectedName((name) => name || profiles.profiles[0]?.name || null);
  }

  useEffect(() => {
    refresh().catch((error) => setNotice({ kind: 'error', text: String(error.message || error) }));
  }, []);

  useEffect(() => {
    if (!selected) return;
    const nextDraft = createDraft(selected);
    setDraft(nextDraft);
    setAuthText(stringifyJson(nextDraft.authJson));
    window.codexSwitch.codex
      .stringifyToml(nextDraft.providerBlock || {})
      .then(setProviderText)
      .catch((error) => setNotice({ kind: 'error', text: String(error.message || error) }));
    setIsNew(false);
  }, [selected?.name]);

  useEffect(() => {
    let cancelled = false;
    async function updateProviderPreview(): Promise<void> {
      if (draft.kind === 'official') {
        setProviderParseError(null);
        return;
      }

      try {
        const providerBlock = providerText.trim() ? await window.codexSwitch.codex.parseToml(providerText) : {};
        if (cancelled) return;
        setProviderParseError(null);
        setDraft((currentDraft) =>
          currentDraft.kind === 'custom'
            ? {
                ...currentDraft,
                providerBlock
              }
            : currentDraft
        );
      } catch (error) {
        if (cancelled) return;
        setProviderParseError(String((error as Error).message || error));
      }
    }

    void updateProviderPreview();
    return () => {
      cancelled = true;
    };
  }, [draft.kind, draft.providerName, providerText]);

  function startCreate(): void {
    const nextDraft = createDraft();
    setProviderText('');
    setDraft(nextDraft);
    setAuthText(stringifyJson(nextDraft.authJson));
    setSelectedName(null);
    setIsNew(true);
    setTab('account');
  }

  function changeDraftKind(kind: ProfileInput['kind']): void {
    if (kind === 'custom') {
      const providerName = draft.providerName || 'custom-provider';
      setDraft({
        ...draft,
        kind,
        providerName,
        providerBlock: draft.providerBlock || { name: providerName, base_url: 'https://example.com/v1', env_key: 'OPENAI_API_KEY' }
      });
      if (!providerText.trim()) {
        setProviderText(`name = "${providerName}"\nbase_url = "https://example.com/v1"\nenv_key = "OPENAI_API_KEY"\n`);
      }
      return;
    }

    setDraft({ ...draft, kind, providerName: undefined, providerBlock: undefined });
  }

  async function parseDraft(): Promise<ProfileInput> {
    const authJson = JSON.parse(authText) as Record<string, unknown>;
    const providerBlock = draft.kind === 'custom' ? await window.codexSwitch.codex.parseToml(providerText) : undefined;
    return {
      ...draft,
      authJson,
      providerName: draft.kind === 'custom' ? draft.providerName : undefined,
      providerBlock
    };
  }

  async function run<T>(task: () => Promise<T>, success: string): Promise<T | null> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await task();
      setNotice({ kind: 'success', text: success });
      await refresh();
      return result;
    } catch (error) {
      setNotice({ kind: 'error', text: String((error as Error).message || error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft(): Promise<void> {
    let parsed: ProfileInput;
    try {
      parsed = await parseDraft();
    } catch (error) {
      setNotice({ kind: 'error', text: `解析失败：${String((error as Error).message || error)}` });
      return;
    }
    const next = await run(
      () => (isNew ? window.codexSwitch.profiles.create(parsed) : window.codexSwitch.profiles.update(selected!.name, parsed)),
      isNew ? 'Profile 已创建' : 'Profile 已保存'
    );
    if (next) {
      setSelectedName(parsed.name);
      setIsNew(false);
    }
  }

  function importCurrent(): void {
    const fallback = `imported-${new Date().toISOString().slice(0, 10)}`;
    setNameDialog({ kind: 'import', title: '导入当前 .codex 配置', value: fallback });
  }

  function renameProfile(name: string): void {
    setNameDialog({ kind: 'rename', title: '重命名 Profile', value: name, originalName: name });
  }

  async function submitNameDialog(): Promise<void> {
    if (!nameDialog) return;
    const value = nameDialog.value.trim();
    if (!value) {
      setNotice({ kind: 'error', text: 'Profile 名称不能为空' });
      return;
    }

    if (nameDialog.kind === 'import') {
      const next = await run(() => window.codexSwitch.profiles.importCurrent(value), '已导入当前 Codex 配置');
      if (next) {
        setSelectedName(value);
        setNameDialog(null);
      }
      return;
    }

    if (value === nameDialog.originalName) {
      setNameDialog(null);
      return;
    }
    const next = await run(() => window.codexSwitch.profiles.rename(nameDialog.originalName, value), 'Profile 已重命名');
    if (next) {
      setSelectedName(value);
      setNameDialog(null);
    }
  }

  async function deleteProfile(name: string): Promise<void> {
    if (!window.confirm(`删除 profile "${name}"？`)) return;
    await run(() => window.codexSwitch.profiles.delete(name), 'Profile 已删除');
    setSelectedName(null);
  }

  function requestSwitch(profileName?: string): void {
    const target = profileName || selected?.name;
    if (!target) return;
    setSwitchDialog({ profileName: target });
  }

  async function confirmSwitch(): Promise<void> {
    if (!switchDialog) return;
    const target = switchDialog.profileName;
    const next = await run(async () => {
      await window.codexSwitch.profiles.switch(target);
      if (typeof window.codexSwitch.codex.restart !== 'function') {
        throw new Error('重启 Codex 的 preload API 尚未加载。请完全关闭并重新启动此 Electron 应用后再试。');
      }
      const restartResult = await window.codexSwitch.codex.restart();
      if (!restartResult.started) {
        throw new Error('已切换 profile，但没有找到正在运行的 Codex 桌面应用路径，因此未重启。请手动重新打开 Codex。');
      }
      return true;
    }, `已切换到 ${target}，并已请求重启 Codex`);
    if (next) setSwitchDialog(null);
  }

  async function switchSelected(): Promise<void> {
    if (!selected) return;
    requestSwitch(selected.name);
  }

  const authObject = parseJsonObject(authText);
  const providerBlock = draft.providerBlock || {};
  const providerBaseUrl = readPath(providerBlock, ['base_url']);
  const providerEnvKey = readPath(providerBlock, ['env_key']);
  const providerWireName = readPath(providerBlock, ['name']);
  const activeName = activeDetected || state.active;

  function updateAuthField(path: string[], value: string): void {
    const next = writePath(authObject || {}, path, value);
    setAuthText(stringifyJson(next));
  }

  function secretInputValue(path: string[]): string {
    const key = path.join('.');
    const value = readPath(authObject, path);
    return focusedSecretPath === key ? value : maskValue(value);
  }

  function secretInputHandlers(path: string[]) {
    const key = path.join('.');
    return {
      onFocus: () => setFocusedSecretPath(key),
      onBlur: () => setFocusedSecretPath((current) => (current === key ? null : current)),
      onChange: (event: ChangeEvent<HTMLInputElement>) => updateAuthField(path, event.target.value)
    };
  }

  function updateProviderField(path: string[], value: string): void {
    const nextBlock = writePath(providerBlock, path, value);
    setDraft({ ...draft, providerBlock: nextBlock });
    void window.codexSwitch.codex.stringifyToml(nextBlock).then(setProviderText);
  }

  return (
    <main className="appShell" onClick={() => setContextMenu(null)}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">CS</div>
          <div>
            <h1>Codex Switch</h1>
            <p>账号与 Provider 切换</p>
          </div>
        </div>

        <button className="primaryAction" disabled={busy} onClick={startCreate}>
          <Plus size={16} />
          新建 Profile
        </button>

        <button className="secondaryAction" disabled={busy} onClick={importCurrent}>
          <Download size={16} />
          导入当前配置
        </button>

        <div className="sectionTitle">Profiles</div>
        <div className="profileList">
          {state.profiles.length === 0 && <div className="empty">还没有 profile</div>}
          {state.profiles.map((profile) => (
            <button
              className={`profileItem ${profile.name === selected?.name ? 'selected' : ''}`}
              key={profile.name}
              onClick={() => setSelectedName(profile.name)}
              onDoubleClick={() => requestSwitch(profile.name)}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedName(profile.name);
                setContextMenu({ name: profile.name, x: event.clientX, y: event.clientY });
              }}
            >
              <span className="profileIcon">{profile.kind === 'official' ? <KeyRound size={16} /> : <Server size={16} />}</span>
              <span className="profileText">
                <strong>{profile.name}</strong>
                <small>{profile.kind === 'official' ? 'Official OpenAI OAuth' : profile.providerName}</small>
              </span>
              {profile.name === activeName && <span className="activeDot" title="当前激活" />}
            </button>
          ))}
        </div>

        {contextMenu && (
          <div
            className="contextMenu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              onClick={() => {
                const name = contextMenu.name;
                setContextMenu(null);
                renameProfile(name);
              }}
            >
              重命名
            </button>
            <button
              className="danger"
              onClick={() => {
                const name = contextMenu.name;
                setContextMenu(null);
                void deleteProfile(name);
              }}
            >
              删除
            </button>
          </div>
        )}

        {switchDialog && (
          <div className="dialogBackdrop" onClick={() => setSwitchDialog(null)}>
            <form
              className="nameDialog"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                void confirmSwitch();
              }}
            >
              <h3>确认切换 Profile</h3>
              <p>
                将切换到 <strong>{switchDialog.profileName}</strong>。确认后会关闭 `codex` 和 `extension-host` 相关进程，然后重新启动
                `codex`，用于重新加载新的 auth/config。
              </p>
              <div className="dialogActions">
                <button type="button" disabled={busy} onClick={() => setSwitchDialog(null)}>
                  取消
                </button>
                <button type="submit" disabled={busy}>
                  确认切换
                </button>
              </div>
            </form>
          </div>
        )}

        {nameDialog && (
          <div className="dialogBackdrop" onClick={() => setNameDialog(null)}>
            <form
              className="nameDialog"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                void submitNameDialog();
              }}
            >
              <h3>{nameDialog.title}</h3>
              <p>
                {nameDialog.kind === 'import'
                  ? '读取当前 ~/.codex/auth.json 和 ~/.codex/config.toml，并保存为一个新的 profile。'
                  : '修改 profile 名称，不会改变 auth.json 或 provider 内容。'}
              </p>
              <label>
                Profile 名称
                <input
                  autoFocus
                  value={nameDialog.value}
                  onChange={(event) => setNameDialog({ ...nameDialog, value: event.target.value })}
                />
              </label>
              <div className="dialogActions">
                <button type="button" disabled={busy} onClick={() => setNameDialog(null)}>
                  取消
                </button>
                <button type="submit" disabled={busy}>
                  确认
                </button>
              </div>
            </form>
          </div>
        )}

      </aside>

      <section className="detailPane">
        <header className="topbar">
          <div>
            <p className="eyeline">当前工作区</p>
            <h2>{isNew ? '新建 Profile' : selected?.name || '选择一个 Profile'}</h2>
          </div>
          <div className="segments" role="tablist">
            <button className={tab === 'account' ? 'active' : ''} onClick={() => setTab('account')}>
              验证
            </button>
            <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>
              供应商
            </button>
          </div>
        </header>

        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

        <div className="statusGrid">
          <div>
            <span>检测激活</span>
            <strong>{activeDetected || '未匹配'}</strong>
          </div>
          <div>
            <span>当前 provider</span>
            <strong>{current?.providerName || 'Official OpenAI OAuth'}</strong>
          </div>
        </div>

        <div className="workspaceCards">
          <div className="workspaceCard">
            <label>
              Profile 名称
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
          </div>
          <div className="workspaceCard compact">
            <label>
              类型
              <select value={draft.kind} onChange={(event) => changeDraftKind(event.target.value as ProfileInput['kind'])}>
                <option value="official">Official OpenAI OAuth</option>
                <option value="custom">自定义</option>
              </select>
            </label>
          </div>
          {draft.kind === 'custom' && (
            <div className="workspaceCard">
              <label>
                Provider 名称
                <input value={draft.providerName || ''} onChange={(event) => setDraft({ ...draft, providerName: event.target.value })} />
              </label>
            </div>
          )}
        </div>

        <div className="editorPanel">
          {tab === 'account' ? (
            <div className="stackEditor">
              <section>
                  <div className="panelHeader">
                  <ShieldCheck size={16} />
                  <strong>掩码预览</strong>
                  <span>{describeAuth(authObject || draft.authJson)}</span>
                </div>
                <div className="previewForm">
                  <label>
                    OPENAI_API_KEY
                    <input
                      value={secretInputValue(['OPENAI_API_KEY'])}
                      {...secretInputHandlers(['OPENAI_API_KEY'])}
                    />
                  </label>
                  {draft.kind === 'official' && (
                    <>
                      <label>
                        id_token
                        <input
                          value={secretInputValue(['tokens', 'id_token'])}
                          {...secretInputHandlers(['tokens', 'id_token'])}
                        />
                      </label>
                      <label>
                        access_token
                        <input
                          value={secretInputValue(['tokens', 'access_token'])}
                          {...secretInputHandlers(['tokens', 'access_token'])}
                        />
                      </label>
                      <label>
                        refresh_token
                        <input
                          value={secretInputValue(['tokens', 'refresh_token'])}
                          {...secretInputHandlers(['tokens', 'refresh_token'])}
                        />
                      </label>
                    </>
                  )}
                </div>
              </section>
              <section>
                <button className="collapseHeader" onClick={() => setAuthEditorOpen((open) => !open)}>
                  <span>
                    <FileJson size={16} />
                    <strong>auth.json</strong>
                  </span>
                  <small>{authEditorOpen ? '收起' : '展开编辑'}</small>
                </button>
                {authEditorOpen && <textarea value={authText} spellCheck={false} onChange={(event) => setAuthText(event.target.value)} />}
              </section>
            </div>
          ) : (
            <div className="stackEditor">
              <section>
                <div className="panelHeader">
                  <CheckCircle2 size={16} />
                  <strong>Provider 预览</strong>
                  <span>{draft.kind === 'official' ? 'Official OpenAI OAuth 会移除 model_provider' : draft.providerName}</span>
                </div>
                {providerParseError && <div className="inlineError">TOML 解析失败：{providerParseError}</div>}
                <div className="previewForm">
                  <label>
                    model_provider
                    <input
                      disabled={draft.kind === 'official'}
                      value={draft.kind === 'official' ? '(移除)' : draft.providerName || ''}
                      onChange={(event) => setDraft({ ...draft, providerName: event.target.value })}
                    />
                  </label>
                  <label>
                    name
                    <input
                      disabled={draft.kind === 'official'}
                      value={draft.kind === 'official' ? 'Official OpenAI OAuth' : providerWireName}
                      onChange={(event) => updateProviderField(['name'], event.target.value)}
                    />
                  </label>
                  <label>
                    base_url
                    <input
                      disabled={draft.kind === 'official'}
                      value={draft.kind === 'official' ? '' : providerBaseUrl}
                      onChange={(event) => updateProviderField(['base_url'], event.target.value)}
                    />
                  </label>
                  <label>
                    env_key
                    <input
                      disabled={draft.kind === 'official'}
                      value={draft.kind === 'official' ? '' : providerEnvKey}
                      onChange={(event) => updateProviderField(['env_key'], event.target.value)}
                    />
                  </label>
                </div>
              </section>
              <section>
                <button className="collapseHeader" onClick={() => setProviderEditorOpen((open) => !open)}>
                  <span>
                    <Server size={16} />
                    <strong>Provider TOML</strong>
                  </span>
                  <small>{providerEditorOpen ? '收起' : '展开编辑'}</small>
                </button>
                {providerEditorOpen && (
                  <textarea
                    value={providerText}
                    spellCheck={false}
                    disabled={draft.kind === 'official'}
                    onChange={(event) => setProviderText(event.target.value)}
                  />
                )}
              </section>
            </div>
          )}
        </div>

        <div className="floatingActions" aria-label="主要操作">
          <button title="切换到选中 Profile" disabled={!selected || busy} onClick={switchSelected}>
            <Zap size={18} />
          </button>
          <button title={isNew ? '创建 Profile' : '保存编辑'} disabled={busy} onClick={saveDraft}>
            <Save size={18} />
          </button>
          <button title="刷新状态" disabled={busy} onClick={() => refresh()}>
            <RefreshCw size={18} />
          </button>
        </div>
      </section>
    </main>
  );
}
