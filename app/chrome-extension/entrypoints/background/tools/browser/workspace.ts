/**
 * Workspace Tool - chrome_workspace
 *
 * Keeps agent-opened tabs inside a named, collapsed tab group so they stay
 * visually separate from the tabs the user opened themselves.
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from '@ethanwilkins/chrome-mcp-shared-2026';

// ============================================================================
// Types
// ============================================================================

interface WorkspaceToolParams {
  action?: 'ensure' | 'list' | 'cleanup';
  name?: string;
}

type WorkspaceMap = Record<string, number>;

const STORAGE_KEY = 'mcp_workspaces';
const DEFAULT_WORKSPACE = 'agent';

// Prefix match so claude-1 / codex-2 keep their agent's colour.
const AGENT_COLORS: Array<[string, chrome.tabGroups.TabGroup['color']]> = [
  ['claude', 'orange'],
  ['codex', 'blue'],
  ['gemini', 'green'],
  ['kimi', 'purple'],
  ['opencode', 'cyan'],
];

function colorFor(name: string): chrome.tabGroups.TabGroup['color'] {
  const lower = name.toLowerCase();
  return AGENT_COLORS.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? 'grey';
}

// ============================================================================
// Storage
// ============================================================================

async function readMap(): Promise<WorkspaceMap> {
  const { [STORAGE_KEY]: map } = await chrome.storage.local.get(STORAGE_KEY);
  return (map as WorkspaceMap) || {};
}

async function writeMap(map: WorkspaceMap): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}

/**
 * Drop entries whose group no longer exists (Chrome deletes a group once its
 * last tab closes, and group IDs do not survive a browser restart).
 */
async function readLiveMap(): Promise<WorkspaceMap> {
  const map = await readMap();
  const live: WorkspaceMap = {};
  let changed = false;
  for (const [name, groupId] of Object.entries(map)) {
    try {
      await chrome.tabGroups.get(groupId);
      live[name] = groupId;
    } catch {
      changed = true;
    }
  }
  if (changed) await writeMap(live);
  return live;
}

// ============================================================================
// Group management
// ============================================================================

/**
 * Return the group ID for `name`, creating a collapsed group (with a blank
 * placeholder tab, since an empty group cannot exist) when it is missing.
 */
export async function ensureWorkspaceGroup(name = DEFAULT_WORKSPACE): Promise<number> {
  const map = await readLiveMap();
  const existing = map[name];
  if (typeof existing === 'number') return existing;

  const placeholder = await chrome.tabs.create({ url: 'about:blank', active: false });
  const groupId = await chrome.tabs.group({ tabIds: [placeholder.id!] });
  await chrome.tabGroups.update(groupId, {
    title: name,
    color: colorFor(name),
    collapsed: true,
  });

  await writeMap({ ...map, [name]: groupId });
  return groupId;
}

/**
 * Move `tabId` into the workspace group. The caller must have created the tab
 * in the group's window, otherwise Chrome relocates it across windows.
 */
export async function addTabToWorkspace(tabId: number, name?: string): Promise<number> {
  const groupId = await ensureWorkspaceGroup(name);
  await chrome.tabs.group({ tabIds: [tabId], groupId });
  return groupId;
}

// ============================================================================
// Implementation
// ============================================================================

class WorkspaceTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WORKSPACE;

  async execute(args: WorkspaceToolParams): Promise<ToolResult> {
    const { action = 'ensure', name } = args;

    try {
      switch (action) {
        case 'ensure': {
          const workspaceName = name || DEFAULT_WORKSPACE;
          const groupId = await ensureWorkspaceGroup(workspaceName);
          const group = await chrome.tabGroups.get(groupId);
          const tabs = await chrome.tabs.query({ groupId });
          return this.json({
            success: true,
            groupId,
            name: group.title || workspaceName,
            color: group.color,
            windowId: group.windowId,
            tabIds: tabs.map((tab) => tab.id).filter((id): id is number => typeof id === 'number'),
          });
        }

        case 'list': {
          const map = await readLiveMap();
          const workspaces = [];
          for (const [workspaceName, groupId] of Object.entries(map)) {
            const group = await chrome.tabGroups.get(groupId);
            const tabs = await chrome.tabs.query({ groupId });
            workspaces.push({
              name: workspaceName,
              groupId,
              color: group.color,
              windowId: group.windowId,
              tabCount: tabs.length,
            });
          }
          return this.json({ success: true, workspaces });
        }

        case 'cleanup': {
          const map = await readLiveMap();
          const targets = name
            ? Object.entries(map).filter(([workspaceName]) => workspaceName === name)
            : Object.entries(map);
          if (name && targets.length === 0) {
            return this.json({ success: true, message: `No workspace named ${name}`, closed: [] });
          }

          const closed = [];
          const remaining = { ...map };
          for (const [workspaceName, groupId] of targets) {
            const tabs = await chrome.tabs.query({ groupId });
            const tabIds = tabs
              .map((tab) => tab.id)
              .filter((id): id is number => typeof id === 'number');
            if (tabIds.length > 0) await chrome.tabs.remove(tabIds);
            delete remaining[workspaceName];
            closed.push({ name: workspaceName, groupId, closedTabs: tabIds.length });
          }
          await writeMap(remaining);
          return this.json({ success: true, closed });
        }

        default:
          return createErrorResponse(`Unknown workspace action: ${action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Workspace ${action} failed: ${message}`);
    }
  }

  private json(payload: unknown): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }
}

export const workspaceTool = new WorkspaceTool();
