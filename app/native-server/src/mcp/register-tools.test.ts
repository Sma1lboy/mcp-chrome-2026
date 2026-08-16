import { describe, expect, test } from '@jest/globals';
import { workspaceFromClientName } from './register-tools';

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
