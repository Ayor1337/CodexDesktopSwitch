import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CODEX_PROCESS_IMAGE_NAMES = ['codex.exe', 'extension-host.exe', 'extensionHost.exe'];

export interface RestartCodexResult {
  killed: string[];
  started: boolean;
  executablePath: string | null;
}

async function findExecutablePath(imageNames: string[]): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const escapedNames = imageNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  const command =
    `$names = @(${escapedNames}); ` +
    'Get-CimInstance Win32_Process | ' +
    'Where-Object { $names -contains $_.Name -and $_.ExecutablePath } | ' +
    'Select-Object -First 1 -ExpandProperty ExecutablePath';

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
    const executablePath = stdout.trim().split(/\r?\n/)[0]?.trim();
    return executablePath || null;
  } catch {
    return null;
  }
}

export function startCodexProcess(executablePath: string): void {
  const child = spawn(executablePath, [], {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
}

export function findRunningCodexExecutablePath(): Promise<string | null> {
  return findExecutablePath(['codex.exe', 'Codex.exe']);
}

async function taskkill(imageName: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await execFileAsync('taskkill.exe', ['/IM', imageName, '/F', '/T'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function stopCodexProcesses(): Promise<string[]> {
  const killed: string[] = [];

  for (const imageName of CODEX_PROCESS_IMAGE_NAMES) {
    if (await taskkill(imageName)) killed.push(imageName);
  }

  return killed;
}

export async function restartCodexProcesses(): Promise<RestartCodexResult> {
  const codexExecutablePath = await findRunningCodexExecutablePath();
  const killed = await stopCodexProcesses();

  if (!codexExecutablePath) {
    return { killed, started: false, executablePath: null };
  }

  startCodexProcess(codexExecutablePath);
  return { killed, started: true, executablePath: codexExecutablePath };
}
