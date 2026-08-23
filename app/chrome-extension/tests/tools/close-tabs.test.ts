import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTabsTool } from '@/entrypoints/background/tools/browser/common';

const query = vi.fn();
const remove = vi.fn();
const get = vi.fn();

vi.mock('@/entrypoints/background/tools/browser/workspace', () => ({
  findWorkspaceGroup: vi.fn(async (name: string) => (name === 'claude' ? 42 : undefined)),
}));

const parse = (result: any) => JSON.parse(result.content[0].text);

describe('chrome_close_tabs never reaches the user tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis.chrome as any).tabs = { query, remove, get };
  });

  it('refuses to close anything when given neither tabIds nor url', async () => {
    const result = await closeTabsTool.execute({} as any);

    expect(result.isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('sweeps a url only inside the caller workspace group', async () => {
    query.mockResolvedValue([{ id: 7 }]);

    const result = await closeTabsTool.execute({
      url: 'https://example.com',
      workspace: 'claude',
    } as any);

    expect(query).toHaveBeenCalledWith(expect.objectContaining({ groupId: 42 }));
    expect(remove).toHaveBeenCalledWith([7]);
    expect(parse(result).closedCount).toBe(1);
  });

  it('closes nothing when the caller has no workspace group yet', async () => {
    const result = await closeTabsTool.execute({
      url: 'https://example.com',
      workspace: 'codex',
    } as any);

    expect(query).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(parse(result).closedCount).toBe(0);
  });
});
