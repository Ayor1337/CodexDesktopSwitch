import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import type { RuntimePaths } from './paths';
import { writeFileAtomic } from './atomic';
import { findRunningCodexExecutablePath, startCodexProcess, stopCodexProcesses, type RestartCodexResult } from './processes';

const execFileAsync = promisify(execFile);

export interface RepairComputerUseCacheResult {
  backupPath: string | null;
  removedPaths: string[];
  configUpdated: boolean;
  environmentEnabled: boolean;
  restart: RestartCodexResult;
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

async function backupConfig(paths: RuntimePaths): Promise<string | null> {
  if (!(await pathExists(paths.config))) return null;
  const backupDir = path.join(paths.codexDir, 'backups', 'config');
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `config.toml.${timestamp()}.computer-use-reset.bak`);
  await fs.copyFile(paths.config, backupPath);
  return backupPath;
}

async function removePathIfExists(target: string, paths: RuntimePaths, removedPaths: string[]): Promise<void> {
  await assertUnderPath(target, paths.codexDir);
  if (!(await pathExists(target))) return;
  await fs.rm(target, { recursive: true, force: true });
  removedPaths.push(target);
}

function stripWindowsLongPathPrefix(value: string): string {
  return value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

function isOldLocalBundledMarketplace(value: unknown, marketplaceRoot: string): boolean {
  if (!isObject(value)) return false;
  if (value.source_type !== 'local') return false;
  if (typeof value.source !== 'string') return true;

  const configuredSource = path.resolve(stripWindowsLongPathPrefix(value.source));
  const expectedSource = path.resolve(marketplaceRoot);
  return configuredSource === expectedSource;
}

function looksLikeCodexBinPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.replace(/[\\/]+/g, '/').toLowerCase().includes('/openai/codex/bin/');
}

function isCodexManagedNodeReplServer(value: unknown): boolean {
  if (!isObject(value)) return false;
  const env = isObject(value.env) ? value.env : {};
  const managedEnvKeys = [
    'BROWSER_USE_CODEX_APP_BUILD_FLAVOR',
    'BROWSER_USE_CODEX_APP_VERSION',
    'CODEX_CLI_PATH',
    'NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S'
  ];

  return (
    looksLikeCodexBinPath(value.command) ||
    looksLikeCodexBinPath(env.NODE_REPL_NODE_PATH) ||
    looksLikeCodexBinPath(env.CODEX_CLI_PATH) ||
    managedEnvKeys.some((key) => typeof env[key] === 'string')
  );
}

function removeEmptyTable(parent: Record<string, unknown>, key: string): void {
  const value = parent[key];
  if (isObject(value) && Object.keys(value).length === 0) delete parent[key];
}

async function updateConfig(paths: RuntimePaths, marketplaceRoot: string): Promise<{ backupPath: string | null; configUpdated: boolean }> {
  let parsed: Record<string, unknown> = {};
  let mode = 0o600;
  let originalText: string | null = null;

  try {
    const stat = await fs.stat(paths.config);
    mode = stat.mode & 0o777;
    originalText = await fs.readFile(paths.config, 'utf8');
    parsed = TOML.parse(originalText);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (isObject(parsed.marketplaces) && isOldLocalBundledMarketplace(parsed.marketplaces['openai-bundled'], marketplaceRoot)) {
    delete parsed.marketplaces['openai-bundled'];
    removeEmptyTable(parsed, 'marketplaces');
  }

  if (isObject(parsed.plugins)) {
    delete parsed.plugins['computer-use@openai-bundled'];
    removeEmptyTable(parsed, 'plugins');
  }

  if (isObject(parsed.mcp_servers) && isCodexManagedNodeReplServer(parsed.mcp_servers.node_repl)) {
    delete parsed.mcp_servers.node_repl;
    removeEmptyTable(parsed, 'mcp_servers');
  }

  parsed.features = { ...(isObject(parsed.features) ? parsed.features : {}), computer_use: true };

  const nextText = TOML.stringify(parsed);
  if (originalText === nextText) {
    return { backupPath: null, configUpdated: false };
  }

  const backupPath = await backupConfig(paths);
  await writeFileAtomic(paths.config, nextText, mode);
  return { backupPath, configUpdated: true };
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
  const executablePath = await findRunningCodexExecutablePath();
  const killed = await stopCodexProcesses();

  const removedPaths: string[] = [];
  const computerUseCacheRoot = path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled', 'computer-use');
  const marketplaceRoot = path.join(paths.codexDir, '.tmp', 'bundled-marketplaces', 'openai-bundled');

  await removePathIfExists(computerUseCacheRoot, paths, removedPaths);
  await removePathIfExists(marketplaceRoot, paths, removedPaths);

  const { backupPath, configUpdated } = await updateConfig(paths, marketplaceRoot);
  const environmentEnabled = await enableUserEnvironment();
  if (executablePath) startCodexProcess(executablePath);

  return {
    backupPath,
    removedPaths,
    configUpdated,
    environmentEnabled,
    restart: {
      killed,
      started: !!executablePath,
      executablePath
    }
  };
}
