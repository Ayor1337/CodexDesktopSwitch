import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeFileAtomic(filePath: string, data: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmpPath, data, { mode });
  await fs.rename(tmpPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // Windows may ignore POSIX-style modes; the write still succeeds.
  }
}
