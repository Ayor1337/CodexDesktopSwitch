import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  Archive,
  CheckCircle2,
  Copy,
  Download,
  FileJson,
  HelpCircle,
  KeyRound,
  Layers,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  Wrench,
  X,
  Zap
} from 'lucide-react';
import type { AppSettings, CurrentCodexState, Profile, ProfileInput, ProfileState, ProxyStatus } from './types';

type Page = 'profiles' | 'settings';
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

const defaultSettings: AppSettings = {
  version: 1,
  launchAtLogin: false,
  silentStartup: false,
  closeBehavior: 'quit',
  themeMode: 'system',
  openAiAuthEnabled: false,
  openAiAuthProfileName: null
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

function writePath(source: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
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

function readBool(source: Record<string, unknown>, path: string[]): boolean {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return current === true;
}

function wrapProviderConfig(providerName: string, providerBlock: Record<string, unknown>): Record<string, unknown> {
  return {
    model_providers: {
      [providerName]: providerBlock
    }
  };
}

function extractProviderBlock(parsed: Record<string, unknown>, providerName: string): Record<string, unknown> {
  const providers = parsed.model_providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    const providerMap = providers as Record<string, unknown>;
    const matched = providerMap[providerName];
    if (matched && typeof matched === 'object' && !Array.isArray(matched)) return matched as Record<string, unknown>;
    const first = Object.values(providerMap).find((value) => value && typeof value === 'object' && !Array.isArray(value));
    if (first) return first as Record<string, unknown>;
  }
  return parsed;
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
  if (typeof authJson.OPENAI_API_KEY === 'string' && authJson.OPENAI_API_KEY) return 'API 密钥';
  if (authJson.tokens && typeof authJson.tokens === 'object') return 'OAuth 令牌';
  return '自定义凭证';
}

function withProviderDefaults(block: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = { ...(block || {}) };
  if (next.wire_api === undefined) next.wire_api = 'responses';
  if (next.requires_openai_auth === undefined) next.requires_openai_auth = true;
  return next;
}

function createDraft(profile?: Profile): ProfileInput {
  if (!profile) return { ...emptyProfile, authJson: { ...emptyProfile.authJson }, providerBlock: {} };
  return {
    name: profile.name,
    kind: profile.kind,
    authJson: profile.authJson,
    providerName: profile.providerName || '',
    providerBlock: profile.kind === 'custom' ? withProviderDefaults(profile.providerBlock) : profile.providerBlock || {},
    useChatCompletionsProxy: profile.useChatCompletionsProxy ?? false,
    model: profile.model ?? null
  };
}

export function App(): JSX.Element {
  const [state, setState] = useState<ProfileState>({ version: 1, active: null, profiles: [] });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [activeDetected, setActiveDetected] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentCodexState | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [page, setPage] = useState<Page>('profiles');
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
  const [repairDialogOpen, setRepairDialogOpen] = useState(false);
  const [authEditorOpen, setAuthEditorOpen] = useState(false);
  const [providerEditorOpen, setProviderEditorOpen] = useState(false);
  const [providerParseError, setProviderParseError] = useState<string | null>(null);
  const [focusedSecretPath, setFocusedSecretPath] = useState<string | null>(null);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>({ running: false, port: null, profileName: null });
  const [isMaximized, setIsMaximized] = useState(false);

  const selected = useMemo(
    () => state.profiles.find((profile) => profile.name === selectedName) || null,
    [selectedName, state.profiles]
  );

  async function refresh(): Promise<void> {
    const [profiles, codexState, detected, appSettings, proxy] = await Promise.all([
      window.codexSwitch.profiles.list(),
      window.codexSwitch.codex.readCurrent(),
      window.codexSwitch.codex.detectActiveProfile(),
      window.codexSwitch.settings.get(),
      window.codexSwitch.codex.proxyStatus()
    ]);
    setState(profiles);
    setCurrent(codexState);
    setActiveDetected(detected);
    setSettings(appSettings);
    setProxyStatus(proxy);
    setSelectedName((name) => name || profiles.profiles[0]?.name || null);
  }

  useEffect(() => {
    refresh().catch((error) => setNotice({ kind: 'error', text: String(error.message || error) }));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.themeMode;
  }, [settings.themeMode]);

  useEffect(() => {
    if (!window.codexSwitch?.window) return;
    window.codexSwitch.window.isMaximized().then(setIsMaximized).catch(() => undefined);
    const off = window.codexSwitch.window.onMaximizeChange(setIsMaximized);
    return () => off();
  }, []);

  useEffect(() => {
    if (!selected) return;
    const nextDraft = createDraft(selected);
    setDraft(nextDraft);
    setAuthText(stringifyJson(nextDraft.authJson));
    if (nextDraft.kind === 'official') {
      setProviderText('');
      setIsNew(false);
      return;
    }
    window.codexSwitch.codex
      .stringifyToml(wrapProviderConfig(nextDraft.providerName || 'custom-provider', nextDraft.providerBlock || {}))
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
        const parsedProviderToml = providerText.trim() ? await window.codexSwitch.codex.parseToml(providerText) : {};
        const providerBlock = extractProviderBlock(parsedProviderToml, draft.providerName || '');
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
    const hasCurrentAuth = !!current?.authJson && Object.keys(current.authJson).length > 0;
    const sourceAuth = hasCurrentAuth
      ? (structuredClone(current!.authJson) as Record<string, unknown>)
      : { ...emptyProfile.authJson };
    const currentModel = typeof current?.config?.model === 'string' ? (current.config.model as string) : null;

    const nextDraft: ProfileInput = {
      name: '',
      kind: 'official',
      authJson: sourceAuth,
      providerName: '',
      providerBlock: {},
      model: currentModel
    };

    setDraft(nextDraft);
    setAuthText(stringifyJson(sourceAuth));
    setProviderText('');
    setSelectedName(null);
    setIsNew(true);
    setPage('profiles');
    setTab('account');
  }

  function changeDraftKind(kind: ProfileInput['kind']): void {
    if (kind === 'custom') {
      const providerName = draft.providerName || 'custom-provider';
      const providerBlock = draft.providerBlock || {
        name: providerName,
        base_url: 'https://tokenflux.dev/v1',
        wire_api: 'responses',
        requires_openai_auth: true
      };
      setDraft({
        ...draft,
        kind,
        providerName,
        providerBlock
      });
      if (!providerText.trim()) {
        void window.codexSwitch.codex.stringifyToml(wrapProviderConfig(providerName, providerBlock)).then(setProviderText);
      }
      return;
    }

    setDraft({ ...draft, kind, providerName: undefined, providerBlock: undefined });
    setTab('account');
  }

  async function parseDraft(): Promise<ProfileInput> {
    const authJson = JSON.parse(authText) as Record<string, unknown>;
    const parsedProviderToml = draft.kind === 'custom' ? await window.codexSwitch.codex.parseToml(providerText) : undefined;
    const providerBlock = parsedProviderToml ? extractProviderBlock(parsedProviderToml, draft.providerName || '') : undefined;
    return {
      ...draft,
      authJson,
      providerName: draft.kind === 'custom' ? draft.providerName : undefined,
      providerBlock: draft.kind === 'custom' ? withProviderDefaults(providerBlock) : providerBlock,
      useChatCompletionsProxy: draft.kind === 'custom' ? !!draft.useChatCompletionsProxy : undefined,
      model: draft.model && draft.model.length > 0 ? draft.model : null
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

  async function saveSettings(patch: Partial<Omit<AppSettings, 'version'>>): Promise<void> {
    const nextSettings = { ...settings, ...patch, version: 1 };
    if (nextSettings.closeBehavior !== 'minimizeToTray') {
      nextSettings.silentStartup = false;
    }
    if (nextSettings.openAiAuthEnabled) {
      const officialProfiles = state.profiles.filter((profile) => profile.kind === 'official');
      if (officialProfiles.length === 0) {
        setNotice({ kind: 'error', text: '没有可用于 OpenAI 官方账号验证的 Official OpenAI OAuth profile' });
        return;
      }
      if (!nextSettings.openAiAuthProfileName) {
        nextSettings.openAiAuthProfileName = officialProfiles[0].name;
      }
    }

    const saved = await run(() => window.codexSwitch.settings.update(nextSettings), '设置已保存');
    if (saved) setSettings(saved);
  }

  async function repairComputerUseCache(): Promise<void> {
    const result = await run(async () => {
      await window.codexSwitch.codex.repairComputerUseCache();
      if (typeof window.codexSwitch.codex.restart !== 'function') {
        throw new Error('修复已完成，但重启 Codex 的 preload API 尚未加载。请完全关闭并重新启动此 Electron 应用后再试。');
      }
      const restartResult = await window.codexSwitch.codex.restart();
      if (!restartResult.started) {
        throw new Error('修复已完成，但没有找到正在运行的 Codex 桌面应用路径，因此未自动重启。请手动重新打开 Codex Desktop。');
      }
      return true;
    }, '修复已完成：已同步本地 openai-bundled marketplace、Computer Use 兼容插件和插件缓存，并已请求重启 Codex Desktop。');
    if (result) setRepairDialogOpen(false);
  }

  const authObject = parseJsonObject(authText);
  const providerBlock = draft.providerBlock || {};
  const providerBaseUrl = readPath(providerBlock, ['base_url']);
  const providerWireApi = readPath(providerBlock, ['wire_api']) || 'responses';
  const providerWireName = readPath(providerBlock, ['name']);
  const providerRequiresOpenAiAuth =
    providerBlock.requires_openai_auth === undefined ? true : readBool(providerBlock, ['requires_openai_auth']);
  const activeName = activeDetected || state.active;
  const officialProfiles = state.profiles.filter((profile) => profile.kind === 'official');
  const selectedOpenAiAuthProfile =
    settings.openAiAuthProfileName && officialProfiles.some((profile) => profile.name === settings.openAiAuthProfileName)
      ? settings.openAiAuthProfileName
      : officialProfiles[0]?.name || '';

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

  function updateProviderName(value: string): void {
    setDraft({ ...draft, providerName: value });
    void window.codexSwitch.codex.stringifyToml(wrapProviderConfig(value || 'custom-provider', providerBlock)).then(setProviderText);
  }

  function updateProviderField(path: string[], value: unknown): void {
    const nextBlock = writePath(providerBlock, path, value);
    setDraft({ ...draft, providerBlock: nextBlock });
    void window.codexSwitch.codex.stringifyToml(wrapProviderConfig(draft.providerName || 'custom-provider', nextBlock)).then(setProviderText);
  }

  function focusActiveProfile(): void {
    if (!activeName) return;
    setSelectedName(activeName);
    setPage('profiles');
  }

  const activeChipLabel = activeName || '未匹配';
  const activeChipKind = activeName ? 'live' : 'idle';

  return (
    <div className="appRoot" onClick={() => setContextMenu(null)}>
      <header className="titleBar">
        <div className="titleBrand">
          <span className="brandMark">CS</span>
          <span className="brandWord">Codex Switch</span>
        </div>
        <button
          type="button"
          className={`activeChip ${activeChipKind}`}
          onClick={focusActiveProfile}
          title={activeName ? `当前激活：${activeName}` : '尚未匹配到任何 profile'}
        >
          <span className="activePulse" />
          <span className="activeChipText">
            <em>当前</em>
            <strong>{activeChipLabel}</strong>
          </span>
          {current?.providerName && <span className="activeChipMeta">· {current.providerName}</span>}
        </button>
        <div className="titleControls">
          <button
            type="button"
            className="winCtrl"
            aria-label="最小化"
            onClick={() => void window.codexSwitch.window.minimize()}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="winCtrl"
            aria-label={isMaximized ? '还原' : '最大化'}
            onClick={() => void window.codexSwitch.window.maximizeToggle()}
          >
            {isMaximized ? <Copy size={12} /> : <Square size={11} />}
          </button>
          <button
            type="button"
            className="winCtrl close"
            aria-label="关闭"
            onClick={() => void window.codexSwitch.window.close()}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <main className="appShell">
        <nav className="navRail" aria-label="主导航">
          <div className="navRailGroup">
            <button
              type="button"
              className={`railItem ${page === 'profiles' ? 'active' : ''}`}
              onClick={() => setPage('profiles')}
              title="Profile 列表"
            >
              <Layers size={18} />
              <span>配置</span>
            </button>
            <button
              type="button"
              className={`railItem ${page === 'settings' ? 'active' : ''}`}
              onClick={() => setPage('settings')}
              title="设置"
            >
              <Settings2 size={18} />
              <span>设置</span>
            </button>
            <button type="button" className="railItem disabled" disabled title="备份（即将推出）">
              <Archive size={18} />
              <span>备份</span>
            </button>
          </div>
          <div className="navRailFooter">
            <button type="button" className="railNew" onClick={startCreate} disabled={busy} title="新建 Profile">
              <Plus size={18} />
            </button>
          </div>
        </nav>

        <aside className="profileColumn">
          <div className="columnHead">
            <span className="caption">配置列表</span>
            <button type="button" className="ghostIconBtn" onClick={importCurrent} disabled={busy} title="导入当前 ~/.codex">
              <Download size={14} />
              <span>导入</span>
            </button>
          </div>
          <div className="profileList">
            {state.profiles.length === 0 && <div className="empty">还没有 profile</div>}
            {state.profiles.map((profile) => (
              <button
                className={`profileItem ${profile.name === selected?.name ? 'selected' : ''}`}
                key={profile.name}
                onClick={() => {
                  setSelectedName(profile.name);
                  setPage('profiles');
                }}
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
        </aside>

        <section className="canvas">
          {page === 'settings' ? (
            <>
              <header className="statusStrip">
                <div>
                  <p className="eyeline">应用配置</p>
                  <h2>偏好设置</h2>
                </div>
              </header>

              {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

              <div className="editorPanel settingsPagePanel">
                <div className="stackEditor">
                  <section>
                    <div className="panelHeader">
                      <ShieldCheck size={16} />
                      <strong>常规</strong>
                      <span>启动与验证</span>
                    </div>
                    <div className="settingsForm">
                      <label className="toggleField">
                        <span>
                          <strong>开机自启动</strong>
                          <small>登录系统后自动启动 Codex Switch</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={settings.launchAtLogin}
                          disabled={busy}
                          onChange={(event) => void saveSettings({ launchAtLogin: event.target.checked })}
                        />
                      </label>
                      <label className="settingsSelectField">
                        <span>
                          <strong>配色模式</strong>
                          <small>选择浅色、深色，或跟随系统外观</small>
                        </span>
                        <select
                          value={settings.themeMode}
                          disabled={busy}
                          onChange={(event) =>
                            void saveSettings({
                              themeMode: event.target.value as AppSettings['themeMode']
                            })
                          }
                        >
                          <option value="light">浅色</option>
                          <option value="dark">深色</option>
                          <option value="system">跟随系统</option>
                        </select>
                      </label>
                      <label className="settingsSelectField">
                        <span>
                          <strong>关闭窗口行为</strong>
                          <small>选择点击关闭按钮时退出应用，或隐藏到系统托盘继续后台运行</small>
                        </span>
                        <select
                          value={settings.closeBehavior}
                          disabled={busy}
                          onChange={(event) =>
                            void saveSettings({
                              closeBehavior: event.target.value as AppSettings['closeBehavior']
                            })
                          }
                        >
                          <option value="quit">直接关闭</option>
                          <option value="minimizeToTray">最小化到后台</option>
                        </select>
                      </label>
                      <label className="toggleField">
                        <span>
                          <strong>静默启动</strong>
                          <small>开机自启动时隐藏主窗口，并保留系统托盘入口</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={settings.silentStartup}
                          disabled={busy || !settings.launchAtLogin || settings.closeBehavior !== 'minimizeToTray'}
                          onChange={(event) => void saveSettings({ silentStartup: event.target.checked })}
                        />
                      </label>
                      <label className="toggleField">
                        <span>
                          <strong>OpenAI 官方账号验证</strong>
                          <small>自定义 provider 切换时保留官方 auth.json 登录态</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={settings.openAiAuthEnabled}
                          disabled={busy || officialProfiles.length === 0}
                          onChange={(event) =>
                            void saveSettings({
                              openAiAuthEnabled: event.target.checked,
                              openAiAuthProfileName: event.target.checked ? selectedOpenAiAuthProfile || null : settings.openAiAuthProfileName
                            })
                          }
                        />
                      </label>
                      {officialProfiles.length === 0 ? (
                        <div className="inlineError">需要先创建或导入一个 Official OpenAI OAuth profile，才能启用官方账号验证。</div>
                      ) : (
                        settings.openAiAuthEnabled && (
                          <>
                            <label>
                              官方账号凭证
                              <select
                                value={selectedOpenAiAuthProfile}
                                disabled={busy}
                                onChange={(event) => void saveSettings({ openAiAuthProfileName: event.target.value })}
                              >
                                {officialProfiles.map((profile) => (
                                  <option key={profile.name} value={profile.name}>
                                    {profile.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <div className="settingsHint">
                              切换自定义 profile 时不会覆盖 auth.json；自定义 OPENAI_API_KEY 会写入 provider 的 experimental_bearer_token。
                            </div>
                          </>
                        )
                      )}
                    </div>
                  </section>
                  <section>
                    <div className="panelHeader">
                      <Wrench size={16} />
                      <strong>维护</strong>
                      <span>Codex 插件缓存</span>
                    </div>
                    <div className="settingsForm">
                      <div className="settingsActionField">
                        <span>
                          <strong>修复 Computer Use 本地兼容插件</strong>
                          <small>
                            备份 config.toml，镜像 openai-bundled marketplace，安装本地 Computer Use 兼容插件并刷新 Browser / Chrome 缓存。
                          </small>
                        </span>
                        <button type="button" className="ghostBtn" disabled={busy} onClick={() => setRepairDialogOpen(true)}>
                          <Wrench size={14} />
                          <span>修复</span>
                        </button>
                      </div>
                      <div className="settingsHint">
                        完成后会自动重启当前运行的 Codex Desktop；该修复不会重打包或重装 Codex Desktop。
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            </>
          ) : (
            <>
              <header className="statusStrip">
                <div>
                  <p className="eyeline">当前工作区</p>
                  <h2>{isNew ? '新建 Profile' : selected?.name || '选择一个 Profile'}</h2>
                </div>
                <div className="segments" role="tablist">
                  <button className={tab === 'account' ? 'active' : ''} onClick={() => setTab('account')}>
                    验证
                  </button>
                  <button
                    className={tab === 'providers' ? 'active' : ''}
                    onClick={() => setTab('providers')}
                    disabled={draft.kind === 'official'}
                    title={draft.kind === 'official' ? '官方订阅无需配置 provider' : '供应商配置'}
                  >
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
                {proxyStatus.running && (
                  <div>
                    <span>翻译代理</span>
                    <strong>
                      127.0.0.1:{proxyStatus.port}
                      {proxyStatus.profileName ? ` · ${proxyStatus.profileName}` : ''}
                    </strong>
                  </div>
                )}
              </div>

              <div className="workspaceCards">
                <div className="workspaceCard">
                  <label>
                    Profile 名称
                    <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                  </label>
                </div>
                <div className="workspaceCard">
                  <span className="cardLabel">类型</span>
                  <div className="kindToggle" role="radiogroup" aria-label="Profile 类型">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draft.kind === 'official'}
                      className={draft.kind === 'official' ? 'active' : ''}
                      onClick={() => changeDraftKind('official')}
                    >
                      <KeyRound size={14} />
                      <span>官方订阅</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draft.kind === 'custom'}
                      className={draft.kind === 'custom' ? 'active' : ''}
                      onClick={() => changeDraftKind('custom')}
                    >
                      <Server size={14} />
                      <span>自定义</span>
                    </button>
                  </div>
                </div>
                {draft.kind === 'custom' && (
                  <div className="workspaceCard">
                    <label>
                      Provider 名称
                      <input value={draft.providerName || ''} onChange={(event) => updateProviderName(event.target.value)} />
                    </label>
                  </div>
                )}
                <div className="workspaceCard">
                  <label>
                    Model
                    <input
                      value={draft.model ?? ''}
                      placeholder="留空则不写入 config.toml model 字段"
                      onChange={(event) =>
                        setDraft({ ...draft, model: event.target.value.length > 0 ? event.target.value : null })
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="editorPanel">
                {tab === 'account' ? (
                  <div className="stackEditor">
                    <section>
                      <div className="panelHeader">
                        <ShieldCheck size={16} />
                        <strong>凭证摘要</strong>
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
                ) : draft.kind === 'official' ? (
                  <div className="providerEmpty">
                    <div className="providerEmptyIcon">
                      <KeyRound size={22} />
                    </div>
                    <h3>官方订阅无需 provider</h3>
                    <p>
                      Official OpenAI OAuth 直接读取 <code>~/.codex/auth.json</code>。
                      切换至该 profile 时，会清除 <code>config.toml</code> 中的 <code>model_provider</code> 字段，
                      让 Codex 走默认通道。
                    </p>
                    <button
                      type="button"
                      className="ghostBtn"
                      onClick={() => changeDraftKind('custom')}
                    >
                      <Server size={14} />
                      改为自定义 provider
                    </button>
                  </div>
                ) : (
                  <div className="stackEditor">
                    <section>
                      <div className="panelHeader">
                        <CheckCircle2 size={16} />
                        <strong>Provider 字段</strong>
                        <span>{draft.providerName}</span>
                      </div>
                      {providerParseError && <div className="inlineError">TOML 解析失败：{providerParseError}</div>}
                      <div className="previewForm">
                        <label>
                          model_provider
                          <input
                            value={draft.providerName || ''}
                            onChange={(event) => updateProviderName(event.target.value)}
                          />
                        </label>
                        <label>
                          name
                          <input
                            value={providerWireName}
                            onChange={(event) => updateProviderField(['name'], event.target.value)}
                          />
                        </label>
                        <label>
                          base_url
                          <input
                            value={providerBaseUrl}
                            onChange={(event) => updateProviderField(['base_url'], event.target.value)}
                          />
                        </label>
                        <label>
                          wire_api
                          <input
                            value={providerWireApi}
                            onChange={(event) => updateProviderField(['wire_api'], event.target.value)}
                          />
                        </label>
                        <label className="checkboxField">
                          requires_openai_auth
                          <input
                            type="checkbox"
                            checked={providerRequiresOpenAiAuth}
                            onChange={(event) => updateProviderField(['requires_openai_auth'], event.target.checked)}
                          />
                        </label>
                        <label className="checkboxField">
                          <span className="labelText">
                            将上游 /chat/completions 翻译为 Responses API
                            <span
                              className="hintTrigger"
                              tabIndex={0}
                              role="button"
                              aria-label="说明"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                            >
                              <HelpCircle size={13} aria-hidden />
                              <span className="hintPopover" role="tooltip">
                                激活该 profile 时会启动本地翻译代理；
                                上游 base_url 仍保存在 profile 中，
                                Codex 实际访问 http://127.0.0.1:&lt;port&gt;/v1。
                              </span>
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            checked={!!draft.useChatCompletionsProxy}
                            onChange={(event) => setDraft({ ...draft, useChatCompletionsProxy: event.target.checked })}
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
                          onChange={(event) => setProviderText(event.target.value)}
                        />
                      )}
                    </section>
                  </div>
                )}
              </div>

              <div className="inlineActionBar">
                <button className="ghostBtn" disabled={busy} onClick={() => refresh()}>
                  <RefreshCw size={14} />
                  刷新状态
                </button>
                <div className="actionRight">
                  <button className="ghostBtn" disabled={busy} onClick={saveDraft}>
                    <Save size={14} />
                    {isNew ? '创建' : '保存'}
                  </button>
                  <button className="primaryBtn" disabled={!selected || busy} onClick={switchSelected}>
                    <Zap size={14} />
                    切换到此 Profile
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </main>

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
              `codex`，用于重新加载新的 auth/config。 若已开启 OpenAI 官方账号验证，切换自定义 profile 时不会覆盖 auth.json。
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

      {repairDialogOpen && (
        <div className="dialogBackdrop" onClick={() => setRepairDialogOpen(false)}>
          <form
            className="nameDialog"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void repairComputerUseCache();
            }}
          >
            <h3>修复 Computer Use 本地兼容插件？</h3>
            <p>
              此操作会备份 <code>~/.codex/config.toml</code>，从已安装 Codex Desktop 镜像 openai-bundled marketplace，安装本地 Computer
              Use 兼容插件，刷新 Browser / Chrome / Computer Use 缓存，并启用 Windows Computer Use 环境变量。完成后会自动重启当前运行的
              Codex Desktop；如果未找到正在运行的桌面应用路径，会提示手动重启。
            </p>
            <div className="dialogActions">
              <button type="button" disabled={busy} onClick={() => setRepairDialogOpen(false)}>
                取消
              </button>
              <button type="submit" disabled={busy}>
                确认修复
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
    </div>
  );
}
