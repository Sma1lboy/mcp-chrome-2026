import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Read a secret for the native server.
 *
 * Chrome spawns the native messaging host, not the user's shell, so a variable
 * exported from .zshrc never reaches `process.env` here. Fall back to the
 * dotenv-style `~/.env` file, which is where these machines already keep keys.
 *
 * Deliberately uncached: a call that needs a key is already making a network
 * request, and re-reading means adding a key to `~/.env` takes effect without
 * restarting Chrome.
 */
export function readLocalEnv(name: string): string {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;

  let contents: string;
  try {
    contents = fs.readFileSync(path.join(os.homedir(), '.env'), 'utf8');
  } catch {
    return '';
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== name) continue;
    return match[2]
      .trim()
      .replace(/\s+#.*$/, '')
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim();
  }
  return '';
}
