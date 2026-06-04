import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimePaths } from './paths';
import { writeFileAtomic } from './atomic';

const BUNDLED_PLUGINS = ['browser', 'chrome', 'computer-use'] as const;

export interface RepairComputerUseCacheResult {
  backupPath: string;
  renamedPaths: string[];
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function ensurePluginDisabled(text: string, plugin: (typeof BUNDLED_PLUGINS)[number]): string {
  const header = `[plugins."${plugin}@openai-bundled"]`;
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp(`^${escapedHeader}\\r?\\n[\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, 'm');
  const block = text.match(blockPattern)?.[0];

  if (!block) {
    return `${text.trimEnd()}\n\n${header}\nenabled = false\n`;
  }

  const nextBlock = /^enabled\s*=/m.test(block)
    ? block.replace(/^enabled\s*=\s*(true|false)\s*$/m, 'enabled = false')
    : `${block.trimEnd()}\nenabled = false\n`;

  return text.replace(blockPattern, nextBlock.endsWith('\n') ? nextBlock : `${nextBlock}\n`);
}

function rewriteConfig(text: string): string {
  let next = text.replace(/^\[marketplaces\.openai-bundled\]\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/m, '');
  next = next.replace(/^js_repl\s*=\s*false\s*$/m, 'js_repl = true');
  next = next.replace(/^sandbox\s*=\s*"elevated"\s*$/m, 'sandbox = "unelevated"');
  for (const plugin of BUNDLED_PLUGINS) {
    next = ensurePluginDisabled(next, plugin);
  }
  return next.endsWith('\n') ? next : `${next}\n`;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function renameCachePath(paths: RuntimePaths, target: string, stamp: string): Promise<string | null> {
  try {
    const [resolvedRoot, resolvedTarget] = await Promise.all([fs.realpath(paths.codexDir), fs.realpath(target)]);
    if (!isInside(resolvedRoot, resolvedTarget)) {
      throw new Error(`拒绝重命名 CODEX_HOME 之外的路径：${resolvedTarget}`);
    }
    const renamed = path.join(path.dirname(resolvedTarget), `${path.basename(resolvedTarget)}.bak-${stamp}`);
    await fs.rename(resolvedTarget, renamed);
    return renamed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function repairComputerUseCache(paths: RuntimePaths): Promise<RepairComputerUseCacheResult> {
  const stamp = timestamp();
  const configText = await fs.readFile(paths.config, 'utf8');
  const backupPath = `${paths.config}.bak-computer-use-${stamp}`;
  await fs.copyFile(paths.config, backupPath);
  await writeFileAtomic(paths.config, rewriteConfig(configText));

  const cachePaths = [
    path.join(paths.codexDir, 'plugins', 'cache', 'openai-bundled'),
    path.join(paths.codexDir, '.tmp', 'bundled-marketplaces', 'openai-bundled')
  ];
  const renamedPaths = (await Promise.all(cachePaths.map((target) => renameCachePath(paths, target, stamp)))).filter(
    (value): value is string => !!value
  );

  return { backupPath, renamedPaths };
}
