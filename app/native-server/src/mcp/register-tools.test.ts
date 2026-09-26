import { describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverSecret, workspaceFromClientName } from './register-tools';

describe('workspaceFromClientName', () => {
  test('reduces harness client names to their agent prefix', () => {
    expect(workspaceFromClientName('claude-code')).toBe('claude');
    expect(workspaceFromClientName('Codex CLI')).toBe('codex');
    expect(workspaceFromClientName('opencode')).toBe('opencode');
    // Unknown names pass through; the group colour falls back to grey.
    expect(workspaceFromClientName('some-new-agent')).toBe('some');
  });

  test('returns undefined when no usable name is present', () => {
    // Callers fall back to MCP_WORKSPACE / 'agent' on undefined, so a client that
    // sends nothing usable must not produce an empty workspace (which means
    // "opt out of grouping" downstream).
    for (const name of [undefined, '', '   ', '///']) {
      expect(workspaceFromClientName(name)).toBeUndefined();
    }
  });
});

describe('deliverSecret', () => {
  const secret = 'sk_live_do_not_leak_123';

  test('writes a 0600 file and returns only length and hash', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sink-')), 'key');
    const result = await deliverSecret(secret, { file });
    expect(readFileSync(file, 'utf8')).toBe(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = JSON.stringify(result);
    expect(text).not.toContain(secret);
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ length: secret.length });
  });

  test('pipes to a command and keeps the value out of error text', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sink-')), 'out');
    await deliverSecret(secret, { command: `cat > ${file}` });
    expect(readFileSync(file, 'utf8')).toBe(secret);
    await expect(deliverSecret(secret, { command: 'cat >&2; exit 3' })).rejects.toThrow(
      /^command exited with 3: $/,
    );
  });
});
