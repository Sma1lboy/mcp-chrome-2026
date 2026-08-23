import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import nativeMessagingHostInstance from '../native-messaging-host';
import { NativeMessageType, TOOL_NAMES, TOOL_SCHEMAS } from '@ethanwilkins/chrome-mcp-shared-2026';
import { randomUUID } from 'node:crypto';

interface ToolActivity {
  requestId: string;
  name: string;
  tabId?: number;
  startedAt: string;
  queueMs?: number;
  executionStartedAt?: string;
  elapsedMs?: number;
  outcome: 'running' | 'success' | 'error' | 'cancelled';
  error?: string;
}
const recentToolCalls: ToolActivity[] = [];
export const getRecentToolCalls = (): ToolActivity[] => recentToolCalls.slice(-20).reverse();
const WRITE_TOOL =
  /(?:navigate|click|scroll|fill|keyboard|key|dialog|computer|upload|paste|proxy_rotate|locate_element|select_all_items)/;
// A native browser dialog can block the helper call used to resolve the active tab.
// Let the dialog tool resolve its own tab instead of adding a second request that
// is guaranteed to time out while beforeunload is visible.
// chrome_navigate also picks its own target: it reuses a tab already showing the
// URL or opens a new one. Injecting the active tab here made every navigate
// hijack whatever tab the user was looking at.
const SELF_RESOLVING_WRITE_TOOLS = new Set([
  TOOL_NAMES.BROWSER.HANDLE_DIALOG,
  TOOL_NAMES.BROWSER.POST_TO_X,
  TOOL_NAMES.BROWSER.NAVIGATE,
]);
// A call may be issued while another tab is active (side panels, devtools,
// file:// tabs, etc.). Keep single-tab inspection/interaction tools attached
// to the tab used by the previous browser operation when tabId is omitted.
const RECENT_TAB_DEFAULT_TOOLS = new Set([
  'chrome_javascript',
  'chrome_extract',
  'chrome_get_web_content',
  'chrome_get_page_text',
  'chrome_read_page',
  'chrome_get_interactive_elements',
  'chrome_console',
  'chrome_screenshot',
  'chrome_scroll',
  'chrome_get_scroll_state',
  'chrome_wait',
  'chrome_keyboard',
  'chrome_paste_text',
  'chrome_paste_image',
  'chrome_get_form_value',
  'chrome_computer',
  'chrome_click_element',
  'chrome_fill_or_select',
  'chrome_upload_file',
]);
const LONG_TOOL =
  /(?:performance|trace|record|download|upload|proxy_diagnostics|collect_virtual_list|select_all_items)/;
const tabQueues = new Map<string, Promise<void>>();
// Tabs this server opens land in their own tab group so they stay separate from
// the user's own tabs. Chrome starts one shared server for every harness, so the
// group has to come from the MCP session's clientInfo rather than the process
// environment; MCP_WORKSPACE is only a fallback (it does fit stdio, where each
// harness runs its own process).
const FALLBACK_WORKSPACE = process.env.MCP_WORKSPACE || 'agent';

/**
 * Reduce an MCP clientInfo.name to a workspace name: 'claude-code' -> 'claude',
 * 'Codex CLI' -> 'codex'. Returns undefined when nothing usable is left.
 */
export function workspaceFromClientName(clientName?: string): string | undefined {
  return /[a-z0-9]+/.exec(String(clientName ?? '').toLowerCase())?.[0];
}
const MIN_TOOL_TRANSPORT_TIMEOUT_MS = 20_000;
type ToolProgressReporter = (progress: Record<string, unknown>) => void | Promise<void>;

export const setupTools = (server: Server) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_SCHEMAS };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = extra._meta?.progressToken;
    let lastProgress = -1;
    const reportProgress: ToolProgressReporter | undefined =
      progressToken === undefined
        ? undefined
        : (progress) =>
            (() => {
              const candidate =
                typeof progress.completed === 'number' && Number.isFinite(progress.completed)
                  ? Math.max(0, Math.floor(progress.completed))
                  : 0;
              const nextProgress = Math.max(lastProgress + 1, candidate);
              lastProgress = nextProgress;
              const total =
                typeof progress.total === 'number' &&
                Number.isFinite(progress.total) &&
                progress.total >= nextProgress
                  ? progress.total
                  : undefined;
              return extra.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: nextProgress,
                  ...(total === undefined ? {} : { total }),
                  message: JSON.stringify(progress),
                },
              });
            })();

    return handleToolCall(
      request.params.name,
      request.params.arguments || {},
      extra.signal,
      reportProgress,
      // getMcpServer() builds one Server per MCP session, and the SDK records the
      // peer's clientInfo on it during initialize, so this is already per-session.
      workspaceFromClientName(server.getClientVersion()?.name),
    );
  });
};

function timeoutFor(name: string, args: any): number {
  const ceiling = LONG_TOOL.test(name) ? 120_000 : 60_000;
  const requested = Number(args.timeoutMs ?? args.timeout);
  return Number.isFinite(requested)
    ? Math.min(Math.max(requested, MIN_TOOL_TRANSPORT_TIMEOUT_MS), ceiling)
    : ceiling;
}

function serialByTab<T>(
  name: string,
  args: any,
  task: () => Promise<T>,
  onStart?: () => void,
): Promise<T> {
  if (args.newWindow || !WRITE_TOOL.test(name)) {
    onStart?.();
    return task();
  }
  const key = `tab:${typeof args.tabId === 'number' ? args.tabId : 'active'}`;
  const previous = tabQueues.get(key) || Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => {
      onStart?.();
      return task();
    });
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tabQueues.set(key, tail);
  void tail.finally(() => {
    if (tabQueues.get(key) === tail) tabQueues.delete(key);
  });
  return result;
}

async function resolveWriteTab(args: any, signal?: AbortSignal): Promise<any> {
  if (typeof args.tabId === 'number' || args.newWindow) return args;
  const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
    { name: 'chrome_get_tab_url', args: { windowId: args.windowId } },
    NativeMessageType.CALL_TOOL,
    5_000,
    signal,
  );
  const text = response?.data?.content?.[0]?.text;
  const tabId = typeof text === 'string' ? JSON.parse(text).tabId : undefined;
  if (typeof tabId !== 'number') throw new Error('Could not resolve the active tab before write');
  return { ...args, tabId };
}

function getRecentTargetTabId(excludeRequestId: string): number | undefined {
  for (let i = recentToolCalls.length - 1; i >= 0; i--) {
    const call = recentToolCalls[i];
    if (call.requestId === excludeRequestId) continue;
    if (typeof call.tabId === 'number' && call.outcome !== 'cancelled') return call.tabId;
  }
  return undefined;
}

async function resolveRecentOrActiveTab(
  args: any,
  signal: AbortSignal | undefined,
  excludeRequestId: string,
): Promise<any> {
  if (typeof args.tabId === 'number' || args.newWindow || Array.isArray(args.tabIds)) return args;

  const recentTabId = getRecentTargetTabId(excludeRequestId);
  if (typeof recentTabId === 'number') return { ...args, tabId: recentTabId };

  const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
    { name: 'chrome_get_tab_url', args: { windowId: args.windowId } },
    NativeMessageType.CALL_TOOL,
    5_000,
    signal,
  );
  const text = response?.data?.content?.[0]?.text;
  const tabId = typeof text === 'string' ? JSON.parse(text).tabId : undefined;
  if (typeof tabId !== 'number') throw new Error('Could not resolve the target tab');
  return { ...args, tabId };
}

const handleToolCall = async (
  name: string,
  args: any,
  signal?: AbortSignal,
  reportProgress?: ToolProgressReporter,
  sessionWorkspace?: string,
): Promise<CallToolResult> => {
  const activity: ToolActivity = {
    requestId: randomUUID(),
    name,
    startedAt: new Date().toISOString(),
    outcome: 'running',
  };
  recentToolCalls.push(activity);
  if (recentToolCalls.length > 100) recentToolCalls.shift();
  try {
    if (
      name === TOOL_NAMES.BROWSER.NAVIGATE &&
      args.workspace === undefined &&
      args.tabId === undefined
    )
      args = { ...args, workspace: sessionWorkspace || FALLBACK_WORKSPACE };
    if (RECENT_TAB_DEFAULT_TOOLS.has(name))
      args = await resolveRecentOrActiveTab(args, signal, activity.requestId);
    if (WRITE_TOOL.test(name) && !SELF_RESOLVING_WRITE_TOOLS.has(name))
      args = await resolveWriteTab(args, signal);
    activity.tabId = args.tabId;
    // 发送请求到Chrome扩展并等待响应
    const queuedAt = Date.now();
    const response = await serialByTab(
      name,
      args,
      () =>
        nativeMessagingHostInstance.sendRequestToExtensionAndWait(
          { name, args },
          NativeMessageType.CALL_TOOL,
          timeoutFor(name, args),
          signal,
          reportProgress,
        ),
      () => {
        activity.queueMs = Date.now() - queuedAt;
        activity.executionStartedAt = new Date().toISOString();
      },
    );
    if (response.status === 'success') {
      activity.outcome = 'success';
      return response.data;
    } else {
      activity.outcome = 'error';
      activity.error = response.error;
      return {
        content: [
          {
            type: 'text',
            text: `Error calling tool: ${response.error}`,
          },
        ],
        isError: true,
      };
    }
  } catch (error: any) {
    activity.outcome = error.message === 'Request cancelled' ? 'cancelled' : 'error';
    activity.error = error.message;
    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool: ${error.message}`,
        },
      ],
      isError: true,
    };
  } finally {
    activity.elapsedMs = Date.now() - new Date(activity.startedAt).getTime();
  }
};
