import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

async function taskkill(imageName: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await execFileAsync('taskkill.exe', ['/IM', imageName, '/F', '/T'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function restartCodexProcesses(): Promise<RestartCodexResult> {
  const killed: string[] = [];
  const imageNames = ['codex.exe', 'extension-host.exe', 'extensionHost.exe'];
  const codexExecutablePath = await findExecutablePath(['codex.exe', 'Codex.exe']);

  for (const imageName of imageNames) {
    if (await taskkill(imageName)) killed.push(imageName);
  }

  if (!codexExecutablePath) {
    return { killed, started: false, executablePath: null };
  }

  const child = spawn(codexExecutablePath, [], {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();

  return { killed, started: true, executablePath: codexExecutablePath };
}
