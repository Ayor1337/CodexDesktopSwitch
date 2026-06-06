import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import type { RuntimePaths } from './paths';
import { writeFileAtomic } from './atomic';

const execFileAsync = promisify(execFile);
const PLUGIN_VERSION = '0.1.0-local';
const BUNDLED_PLUGINS = ['browser', 'chrome'] as const;

export interface RepairComputerUseCacheResult {
  backupPath: string | null;
  marketplaceRoot: string;
  pluginSourceRoot: string;
  cacheVersionRoot: string;
  syncedCacheRoots: string[];
  chromeNativeManifestPath: string | null;
  environmentEnabled: boolean;
}

interface MarketplaceManifest {
  name?: string;
  interface?: Record<string, unknown>;
  plugins?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertUnderPath(target: string, parent: string): Promise<void> {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  if (!isInside(resolvedParent, resolvedTarget)) {
    throw new Error(`拒绝修改预期目录之外的路径：${resolvedTarget}`);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(target: string): Promise<T> {
  return JSON.parse(await fs.readFile(target, 'utf8')) as T;
}

async function writeJsonFile(target: string, value: unknown): Promise<void> {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function backupConfig(paths: RuntimePaths): Promise<string | null> {
  if (!(await pathExists(paths.config))) return null;
  const backupDir = path.join(paths.codexDir, 'backups', 'config');
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `config.toml.${timestamp()}.computer-use-local.bak`);
  await fs.copyFile(paths.config, backupPath);
  return backupPath;
}

function setTable(parsed: Record<string, unknown>, pathParts: string[], values: Record<string, unknown>): void {
  let current = parsed;
  for (const part of pathParts.slice(0, -1)) {
    if (!isObject(current[part])) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[pathParts[pathParts.length - 1]] = values;
}

async function updateConfig(paths: RuntimePaths, marketplaceRoot: string): Promise<string | null> {
  const backupPath = await backupConfig(paths);
  let parsed: Record<string, unknown> = {};
  let mode = 0o600;
  try {
    const stat = await fs.stat(paths.config);
    mode = stat.mode & 0o777;
    parsed = TOML.parse(await fs.readFile(paths.config, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  setTable(parsed, ['marketplaces', 'openai-bundled'], {
    last_updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: `\\\\?\\${marketplaceRoot}`,
    source_type: 'local'
  });
  setTable(parsed, ['plugins', 'computer-use@openai-bundled'], { enabled: true });
  setTable(parsed, ['windows'], { ...(isObject(parsed.windows) ? parsed.windows : {}), sandbox: 'unelevated' });
  setTable(parsed, ['features'], { ...(isObject(parsed.features) ? parsed.features : {}), computer_use: true });

  await writeFileAtomic(paths.config, TOML.stringify(parsed), mode);
  return backupPath;
}

async function findInstalledBundledMarketplaceRoot(): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('Computer Use 本地修复当前只支持 Windows');
  }

  const command =
    "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
  const installLocation = stdout.trim().split(/\r?\n/)[0]?.trim();
  if (!installLocation) throw new Error('未找到 Windows Store/MSIX 版 OpenAI.Codex');

  const root = path.join(installLocation, 'app', 'resources', 'plugins', 'openai-bundled');
  const manifest = path.join(root, '.agents', 'plugins', 'marketplace.json');
  if (!(await pathExists(manifest))) {
    throw new Error(`已安装 Codex 的 openai-bundled marketplace 不存在：${manifest}`);
  }
  return root;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true, verbatimSymlinks: false });
}

async function syncBundledMarketplace(sourceRoot: string, marketplaceRoot: string, paths: RuntimePaths): Promise<void> {
  await assertUnderPath(marketplaceRoot, paths.codexDir);
  await copyDirectory(sourceRoot, marketplaceRoot);
}

function pluginJson(): Record<string, unknown> {
  return {
    name: 'computer-use',
    version: PLUGIN_VERSION,
    description: 'Local Windows Computer Use compatibility helper for Codex Desktop.',
    author: { name: 'Local' },
    homepage: 'https://openai.com/',
    repository: 'https://openai.com/',
    license: 'Proprietary',
    keywords: ['computer-use', 'windows', 'desktop'],
    skills: './skills/',
    interface: {
      displayName: 'Computer Use',
      shortDescription: 'Control this Windows desktop from Codex',
      longDescription: 'Local compatibility plugin that provides the Windows helper paths expected by Codex Desktop Computer Use.',
      developerName: 'Local',
      category: 'Productivity',
      capabilities: ['Interactive', 'Read', 'Write'],
      websiteURL: 'https://openai.com/',
      privacyPolicyURL: 'https://openai.com/policies/row-privacy-policy/',
      termsOfServiceURL: 'https://openai.com/policies/row-terms-of-use/',
      defaultPrompt: ['Look at my screen and help me navigate'],
      brandColor: '#10A37F',
      screenshots: []
    }
  };
}

function skillMarkdown(): string {
  return [
    '---',
    'name: computer-use',
    'description: Local Windows Computer Use compatibility helper for Codex Desktop.',
    '---',
    '',
    '# Computer Use',
    '',
    'This local compatibility plugin supplies the Windows helper transport paths that Codex Desktop resolves for Computer Use.',
    '',
    'The Desktop app must be restarted after installation so CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE=1 is visible.',
    ''
  ].join('\n');
}

function helperTransportJs(): string {
  return [
    'import { execFile } from "node:child_process";',
    'import { appendFile, mkdir } from "node:fs/promises";',
    'import { dirname, join } from "node:path";',
    'import { promisify } from "node:util";',
    '',
    'const execFileAsync = promisify(execFile);',
    'const logPath = join(process.env.LOCALAPPDATA || process.env.TEMP || ".", "OpenAI", "Codex", "computer-use-local-helper.log");',
    '',
    'async function log(entry) {',
    '  try {',
    '    await mkdir(dirname(logPath), { recursive: true });',
    '    await appendFile(logPath, new Date().toISOString() + " " + JSON.stringify(entry) + "\\n", "utf8");',
    '  } catch {}',
    '}',
    '',
    'function encodePowerShell(script) {',
    '  return Buffer.from(script, "utf16le").toString("base64");',
    '}',
    '',
    'async function runPowerShell(lines, timeout = 30000) {',
    '  const script = Array.isArray(lines) ? lines.join("\\n") : String(lines);',
    '  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)], {',
    '    encoding: "utf8", env: process.env, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,',
    '  });',
    '  const text = stdout.trim();',
    '  return text.length === 0 ? null : JSON.parse(text);',
    '}',
    '',
    'function numberFrom(params, names, fallback = 0) {',
    '  for (const name of names) {',
    '    const value = params?.[name];',
    '    if (typeof value === "number" && Number.isFinite(value)) return value;',
    '    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);',
    '  }',
    '  return fallback;',
    '}',
    '',
    'function buttonFrom(params) {',
    '  const raw = String(params?.button || params?.mouseButton || "left").toLowerCase();',
    '  if (raw.includes("right")) return "right";',
    '  if (raw.includes("middle")) return "middle";',
    '  return "left";',
    '}',
    '',
    'const user32Script = [',
    '  "Add-Type -TypeDefinition @\\"",',
    '  "using System;",',
    '  "using System.Runtime.InteropServices;",',
    '  "public static class CodexUser32 {",',
    '  "  [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y);",',
    '  "  [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);",',
    '  "}",',
    '  "\\"@",',
    '];',
    '',
    'function mouseFlags(button, action) {',
    '  if (button === "right") return action === "down" ? "0x0008" : "0x0010";',
    '  if (button === "middle") return action === "down" ? "0x0020" : "0x0040";',
    '  return action === "down" ? "0x0002" : "0x0004";',
    '}',
    '',
    'async function screenshot() {',
    '  return await runPowerShell([',
    '    "Add-Type -AssemblyName System.Windows.Forms",',
    '    "Add-Type -AssemblyName System.Drawing",',
    '    "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen",',
    '    "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",',
    '    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",',
    '    "$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)",',
    '    "$stream = New-Object System.IO.MemoryStream",',
    '    "$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)",',
    '    "$graphics.Dispose(); $bitmap.Dispose()",',
    '    "$bytes = $stream.ToArray(); $stream.Dispose()",',
    '    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",',
    '    "[Console]::Write((ConvertTo-Json -Compress @{ mimeType = \\"image/png\\"; data = [Convert]::ToBase64String($bytes); width = $bounds.Width; height = $bounds.Height; left = $bounds.Left; top = $bounds.Top }))",',
    '  ]);',
    '}',
    '',
    'async function screenInfo() {',
    '  return await runPowerShell([',
    '    "Add-Type -AssemblyName System.Windows.Forms",',
    '    "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen",',
    '    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",',
    '    "[Console]::Write((ConvertTo-Json -Compress @{ width = $bounds.Width; height = $bounds.Height; left = $bounds.Left; top = $bounds.Top }))",',
    '  ]);',
    '}',
    '',
    'async function moveMouse(params) {',
    '  const x = Math.round(numberFrom(params, ["x", "X", "left"]));',
    '  const y = Math.round(numberFrom(params, ["y", "Y", "top"]));',
    '  return await runPowerShell([...user32Script, "[CodexUser32]::SetCursorPos(" + x + ", " + y + ") | Out-Null", "[Console]::Write(\'{\\"ok\\":true}\')"]);',
    '}',
    '',
    'async function clickMouse(params, count = 1) {',
    '  const x = Math.round(numberFrom(params, ["x", "X", "left"], Number.NaN));',
    '  const y = Math.round(numberFrom(params, ["y", "Y", "top"], Number.NaN));',
    '  const button = buttonFrom(params);',
    '  const lines = [...user32Script];',
    '  if (Number.isFinite(x) && Number.isFinite(y)) lines.push("[CodexUser32]::SetCursorPos(" + x + ", " + y + ") | Out-Null");',
    '  lines.push("for ($i = 0; $i -lt " + count + "; $i++) {");',
    '  lines.push("  [CodexUser32]::mouse_event(" + mouseFlags(button, "down") + ", 0, 0, 0, [UIntPtr]::Zero)");',
    '  lines.push("  Start-Sleep -Milliseconds 35");',
    '  lines.push("  [CodexUser32]::mouse_event(" + mouseFlags(button, "up") + ", 0, 0, 0, [UIntPtr]::Zero)");',
    '  lines.push("  Start-Sleep -Milliseconds 70");',
    '  lines.push("}");',
    '  lines.push("[Console]::Write(\'{\\"ok\\":true}\')");',
    '  return await runPowerShell(lines);',
    '}',
    '',
    'async function scrollMouse(params) {',
    '  const delta = Math.round(numberFrom(params, ["delta", "wheelDelta"], 0) || -120 * numberFrom(params, ["amount", "clicks"], 1));',
    '  return await runPowerShell([...user32Script, "[CodexUser32]::mouse_event(0x0800, 0, 0, " + delta + ", [UIntPtr]::Zero)", "[Console]::Write(\'{\\"ok\\":true}\')"]);',
    '}',
    '',
    'function sendKeysLiteral(text) {',
    '  return String(text).replaceAll("{", "{{}").replaceAll("}", "{}}").replaceAll("+", "{+}").replaceAll("^", "{^}").replaceAll("%", "{%}").replaceAll("~", "{~}").replaceAll("(", "{(}").replaceAll(")", "{)}").replaceAll("[", "{[}").replaceAll("]", "{]}").replaceAll("\\n", "{ENTER}");',
    '}',
    '',
    'function normalizeKey(key) {',
    '  const value = String(key || "").trim();',
    '  const upper = value.toUpperCase();',
    '  const aliases = { ENTER: "{ENTER}", RETURN: "{ENTER}", ESC: "{ESC}", ESCAPE: "{ESC}", TAB: "{TAB}", BACKSPACE: "{BACKSPACE}", DELETE: "{DELETE}", DEL: "{DELETE}", SPACE: " ", UP: "{UP}", DOWN: "{DOWN}", LEFT: "{LEFT}", RIGHT: "{RIGHT}", HOME: "{HOME}", END: "{END}", PAGEUP: "{PGUP}", PAGEDOWN: "{PGDN}" };',
    '  if (aliases[upper]) return aliases[upper];',
    '  if (/^F([1-9]|1[0-2])$/.test(upper)) return "{" + upper + "}";',
    '  return sendKeysLiteral(value);',
    '}',
    '',
    'async function sendKeys(keys) {',
    '  const encoded = Buffer.from(keys, "utf8").toString("base64");',
    '  return await runPowerShell(["Add-Type -AssemblyName System.Windows.Forms", "$keys = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\\"" + encoded + "\\"))", "[System.Windows.Forms.SendKeys]::SendWait($keys)", "[Console]::Write(\'{\\"ok\\":true}\')"]);',
    '}',
    '',
    'export class WindowsHelperTransport {',
    '  constructor({ helperArgs = [], helperCommand = null } = {}) {',
    '    this.helperArgs = helperArgs;',
    '    this.helperCommand = helperCommand;',
    '    log({ event: "transport-created", helperCommand, helperArgs }).catch(() => {});',
    '  }',
    '',
    '  async request(method, params = {}, options = {}) {',
    '    await log({ event: "request", method, params, hasTurnMetadata: !!options?.codexTurnMetadata });',
    '    const name = String(method || "").replace(/[-_]/g, "").toLowerCase();',
    '    if (name === "ping") return "pong";',
    '    if (["screenshot", "takescreenshot", "capture", "captureimage", "capturescreen", "screencapture"].includes(name)) return await screenshot();',
    '    if (["screeninfo", "getscreeninfo", "displays", "getdisplays", "screenstate"].includes(name)) return await screenInfo();',
    '    if (["movemouse", "mousemove", "move"].includes(name)) return await moveMouse(params);',
    '    if (["click", "mouseclick", "clickmouse"].includes(name)) return await clickMouse(params, 1);',
    '    if (["doubleclick", "mousedoubleclick"].includes(name)) return await clickMouse(params, 2);',
    '    if (["scroll", "mousescroll", "scrollmouse"].includes(name)) return await scrollMouse(params);',
    '    if (["type", "typetext", "text"].includes(name)) return await sendKeys(sendKeysLiteral(params?.text ?? params?.value ?? params?.input ?? ""));',
    '    if (["keypress", "presskey", "key", "sendkey"].includes(name)) return await sendKeys(normalizeKey(params?.key ?? params?.keys ?? params?.text ?? params?.value ?? ""));',
    '    if (["close", "shutdown"].includes(name)) return { ok: true };',
    '    throw new Error("Unsupported local Computer Use helper method: " + method);',
    '  }',
    '',
    '  async close() {',
    '    await log({ event: "transport-closed" });',
    '  }',
    '}',
    ''
  ].join('\n');
}

async function writeTextFile(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function writePluginTree(root: string): Promise<void> {
  await writeJsonFile(path.join(root, '.codex-plugin', 'plugin.json'), pluginJson());
  await writeTextFile(path.join(root, 'skills', 'computer-use', 'SKILL.md'), skillMarkdown());
  await writeJsonFile(path.join(root, 'node_modules', '@oai', 'sky', 'package.json'), {
    name: '@oai/sky',
    version: PLUGIN_VERSION,
    type: 'module',
    private: true
  });
  await writeTextFile(
    path.join(root, 'node_modules', '@oai', 'sky', 'bin', 'windows', 'codex-computer-use.exe'),
    '# Placeholder executable path for Codex Desktop Windows Computer Use resolution.\n'
  );
  await writeTextFile(
    path.join(root, 'node_modules', '@oai', 'sky', 'dist', 'project', 'cua', 'sky_js', 'src', 'targets', 'windows', 'internal', 'helper_transport.js'),
    helperTransportJs()
  );
}

async function updateBundledMarketplaceManifest(marketplaceRoot: string): Promise<void> {
  const manifestPath = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const manifest = (await pathExists(manifestPath))
    ? await readJsonFile<MarketplaceManifest>(manifestPath)
    : ({ name: 'openai-bundled', interface: { displayName: 'OpenAI Bundled' }, plugins: [] } satisfies MarketplaceManifest);

  manifest.name ||= 'openai-bundled';
  manifest.interface ||= { displayName: 'OpenAI Bundled' };
  const entry = {
    name: 'computer-use',
    source: { source: 'local', path: './plugins/computer-use' },
    policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' },
    category: 'Productivity'
  };
  manifest.plugins = [entry, ...((manifest.plugins || []).filter((plugin) => plugin.name !== 'computer-use'))];
  await writeJsonFile(manifestPath, manifest);
}

async function removePath(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

async function createLatestLink(target: string, latestPath: string): Promise<void> {
  await removePath(latestPath);
  try {
    await fs.symlink(target, latestPath, 'junction');
  } catch {
    await copyDirectory(target, latestPath);
  }
}

async function getPluginVersion(pluginRoot: string): Promise<string> {
  const manifest = await readJsonFile<{ version?: unknown }>(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`插件 manifest 缺少 version：${pluginRoot}`);
  }
  return manifest.version;
}

async function syncBundledPluginCache(paths: RuntimePaths, marketplaceRoot: string, pluginName: (typeof BUNDLED_PLUGINS)[number]): Promise<string> {
  const sourceRoot = path.join(marketplaceRoot, 'plugins', pluginName);
  const version = await getPluginVersion(sourceRoot);
  const cacheRoot = path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled', pluginName);
  const cacheVersionRoot = path.join(cacheRoot, version);
  await assertUnderPath(cacheVersionRoot, cacheRoot);
  await copyDirectory(sourceRoot, cacheVersionRoot);
  await createLatestLink(cacheVersionRoot, path.join(cacheRoot, 'latest'));
  return cacheVersionRoot;
}

async function updateChromeNativeMessagingManifest(chromeCacheRoot: string): Promise<string | null> {
  const hostExe = path.join(chromeCacheRoot, 'extension-host', 'windows', 'x64', 'extension-host.exe');
  if (!(await pathExists(hostExe))) return null;

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const manifestPath = path.join(localAppData, 'OpenAI', 'extension', 'com.openai.codexextension.json');
  if (!(await pathExists(manifestPath))) return null;

  const manifest = await readJsonFile<Record<string, unknown>>(manifestPath);
  if (manifest.path === hostExe) return manifestPath;

  await fs.copyFile(manifestPath, `${manifestPath}.${timestamp()}.bak`);
  manifest.path = hostExe;
  await writeJsonFile(manifestPath, manifest);
  return manifestPath;
}

async function enableUserEnvironment(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  process.env.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE = '1';
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-Command', "[Environment]::SetEnvironmentVariable('CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE','1','User')"],
    { windowsHide: true }
  );
  return true;
}

export async function repairComputerUseCache(paths: RuntimePaths): Promise<RepairComputerUseCacheResult> {
  await fs.mkdir(paths.codexDir, { recursive: true });
  if (!fsSync.existsSync(paths.codexDir)) throw new Error(`CODEX_HOME 不存在：${paths.codexDir}`);

  const sourceRoot = await findInstalledBundledMarketplaceRoot();
  const marketplaceRoot = path.join(paths.codexDir, '.tmp', 'bundled-marketplaces', 'openai-bundled');
  const pluginSourceRoot = path.join(marketplaceRoot, 'plugins', 'computer-use');
  const computerUseCacheRoot = path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled', 'computer-use');
  const cacheVersionRoot = path.join(computerUseCacheRoot, PLUGIN_VERSION);

  await syncBundledMarketplace(sourceRoot, marketplaceRoot, paths);
  await assertUnderPath(pluginSourceRoot, marketplaceRoot);
  await assertUnderPath(cacheVersionRoot, computerUseCacheRoot);
  await writePluginTree(pluginSourceRoot);
  await writePluginTree(cacheVersionRoot);
  await updateBundledMarketplaceManifest(marketplaceRoot);
  const backupPath = await updateConfig(paths, marketplaceRoot);
  const environmentEnabled = await enableUserEnvironment();

  const syncedCacheRoots = [];
  for (const plugin of BUNDLED_PLUGINS) {
    syncedCacheRoots.push(await syncBundledPluginCache(paths, marketplaceRoot, plugin));
  }
  await createLatestLink(cacheVersionRoot, path.join(computerUseCacheRoot, 'latest'));
  const chromeNativeManifestPath = await updateChromeNativeMessagingManifest(syncedCacheRoots[1]);

  return {
    backupPath,
    marketplaceRoot,
    pluginSourceRoot,
    cacheVersionRoot,
    syncedCacheRoots,
    chromeNativeManifestPath,
    environmentEnabled
  };
}
