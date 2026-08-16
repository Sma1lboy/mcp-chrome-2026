import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  workspaceTool,
  ensureWorkspaceGroup,
} from '@/entrypoints/background/tools/browser/workspace';

/** In-memory stand-ins for the tab/group state the tool reads and writes. */
let storage: Record<string, any>;
let groups: Map<number, { id: number; title?: string; color: string; windowId: number }>;
let tabs: Array<{ id: number; groupId: number; windowId: number }>;
let nextId: number;

beforeEach(() => {
  storage = {};
  groups = new Map();
  tabs = [];
  nextId = 100;

  (chrome.storage.local.get as any).mockImplementation(async (key: string) => ({
    [key]: storage[key],
  }));
  (chrome.storage.local.set as any).mockImplementation(async (items: Record<string, any>) => {
    Object.assign(storage, items);
  });
  (chrome.tabs.create as any).mockImplementation(async () => {
    const tab = { id: nextId++, groupId: -1, windowId: 1 };
    tabs.push(tab);
    return tab;
  });
  (chrome.tabs.query as any).mockImplementation(async ({ groupId }: { groupId: number }) =>
    tabs.filter((tab) => tab.groupId === groupId),
  );
  (chrome.tabs.remove as any).mockImplementation(async (ids: number[]) => {
    tabs = tabs.filter((tab) => !ids.includes(tab.id));
  });
  (chrome as any).tabs.group = vi.fn(async ({ tabIds, groupId }: any) => {
    const id = groupId ?? nextId++;
    if (!groups.has(id)) groups.set(id, { id, color: 'grey', windowId: 1 });
    for (const tabId of tabIds) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab) tab.groupId = id;
    }
    return id;
  });
  (chrome as any).tabGroups = {
    get: vi.fn(async (groupId: number) => {
      const group = groups.get(groupId);
      if (!group) throw new Error(`No group with id: ${groupId}.`);
      return group;
    }),
    update: vi.fn(async (groupId: number, props: any) => {
      Object.assign(groups.get(groupId)!, props);
      return groups.get(groupId);
    }),
  };
});

const parse = (result: any) => JSON.parse(result.content[0].text);

describe('workspace tab groups', () => {
  it('creates a named group on first ensure and reuses it afterwards', async () => {
    const first = parse(await workspaceTool.execute({ action: 'ensure', name: 'claude' }));
    const second = parse(await workspaceTool.execute({ action: 'ensure', name: 'claude' }));

    expect(first.groupId).toBe(second.groupId);
    expect(first.name).toBe('claude');
    // A group cannot exist without a tab, so ensure seeds exactly one placeholder.
    expect(second.tabIds).toHaveLength(1);
  });

  it('maps agent name prefixes to a stable colour', async () => {
    expect(parse(await workspaceTool.execute({ name: 'claude-1' })).color).toBe('orange');
    expect(parse(await workspaceTool.execute({ name: 'codex' })).color).toBe('blue');
    expect(parse(await workspaceTool.execute({ name: 'someone-else' })).color).toBe('grey');
  });

  it('forgets a group whose tabs were all closed', async () => {
    const groupId = await ensureWorkspaceGroup('claude');
    // Simulate Chrome deleting the group once its last tab closes.
    groups.delete(groupId);
    tabs = [];

    expect(parse(await workspaceTool.execute({ action: 'list' })).workspaces).toEqual([]);
    // A later ensure must rebuild rather than hand back the dead ID.
    expect(await ensureWorkspaceGroup('claude')).not.toBe(groupId);
  });

  it('cleanup closes only the named workspace', async () => {
    await ensureWorkspaceGroup('claude');
    await ensureWorkspaceGroup('codex');

    parse(await workspaceTool.execute({ action: 'cleanup', name: 'claude' }));

    const remaining = parse(await workspaceTool.execute({ action: 'list' })).workspaces;
    expect(remaining.map((workspace: any) => workspace.name)).toEqual(['codex']);
  });

  it('cleanup without a name clears every workspace', async () => {
    await ensureWorkspaceGroup('claude');
    await ensureWorkspaceGroup('codex');

    parse(await workspaceTool.execute({ action: 'cleanup' }));

    expect(parse(await workspaceTool.execute({ action: 'list' })).workspaces).toEqual([]);
    expect(tabs).toHaveLength(0);
  });
});
