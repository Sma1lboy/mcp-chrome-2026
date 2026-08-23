import { createErrorResponse, type ToolProgressReporter } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import * as browserTools from './browser';
import { getMessage as t } from '@/utils/i18n';

const tools = browserTools as any;
const toolsMap = new Map(Object.values(tools).map((tool: any) => [tool.name, tool]));

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
}

function compact(value: unknown, max = 72): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// t() is called inside these helpers, never held in a module-level constant:
// that would freeze the overlay in whichever language loaded first.
function duration(value: unknown, fallbackMs: number): string {
  const ms = typeof value === 'number' && value >= 0 ? value : fallbackMs;
  return t('ovSeconds', [String(ms / 1000)]);
}

function target(args: Record<string, unknown>): string {
  const selector = compact(args.selector);
  if (selector) return selector;
  const ref = compact(args.ref);
  if (ref) return t('ovElementRef', [ref]);
  const coordinates = args.coordinates as { x?: unknown; y?: unknown } | undefined;
  if (typeof coordinates?.x === 'number' && typeof coordinates.y === 'number')
    return t('ovCoordinates', [String(coordinates.x), String(coordinates.y)]);
  return t('ovTargetFallback');
}

function actionLabel(name: string): string {
  const key = `ovLabel_${name}`;
  const label = t(key);
  return label === key ? name.replace(/^chrome_/, '') : label;
}

function operationDetail(param: ToolCallParam): string {
  const args = (param.args || {}) as Record<string, unknown>;
  const d = (key: string, subs?: string[]) => t(`ovDetail_${key}`, subs);
  switch (param.name) {
    case 'get_windows_and_tabs':
      return d('get_windows_and_tabs');
    case 'search_tabs_content':
      return d('search_tabs_content', [
        compact(args.query || args.text) || d('search_tabs_content_fallback'),
      ]);
    case 'chrome_screenshot':
      return args.fullPage
        ? d('chrome_screenshot_full')
        : d('chrome_screenshot_target', [target(args)]);
    case 'chrome_close_tabs':
      return d('chrome_close_tabs', [String(Array.isArray(args.tabIds) ? args.tabIds.length : 1)]);
    case 'chrome_switch_tab':
      return d('chrome_switch_tab', [String(args.tabId || d('chrome_switch_tab_current'))]);
    case 'chrome_get_web_content':
      return d('chrome_get_web_content', [
        args.htmlContent ? 'HTML' : d('chrome_get_web_content_text'),
        compact(args.url) || target(args),
      ]);
    case 'chrome_get_interactive_elements': {
      const query = compact(args.textQuery);
      return query
        ? d('chrome_get_interactive_elements_query', [query])
        : d('chrome_get_interactive_elements');
    }
    case 'chrome_request_element_selection': {
      const names = Array.isArray(args.requests)
        ? args.requests
            .map((request: { name?: unknown }) => compact(request?.name, 30))
            .filter(Boolean)
        : [];
      const listed =
        names.slice(0, 3).join(d('chrome_request_element_selection_join')) ||
        d('chrome_request_element_selection_fallback');
      const more = names.length > 3 ? d('chrome_request_element_selection_more') : '';
      return d('chrome_request_element_selection', [
        `${listed}${more}`,
        duration(args.timeoutMs, 180_000),
      ]);
    }
    case 'chrome_click_element':
      return d('chrome_click_element', [target(args)]);
    case 'chrome_click_and_wait':
      return d('chrome_click_and_wait', [
        target(args),
        compact(args.waitSelector) || d('chrome_click_and_wait_fallback'),
        String(args.waitFor || 'visible'),
        duration(args.waitTimeout, 10_000),
      ]);
    case 'chrome_wait':
      return d('chrome_wait', [
        compact(args.jsCondition) || target(args),
        String(args.waitFor || 'visible'),
        duration(args.timeout, 10_000),
      ]);
    case 'chrome_fill_or_select':
      return d('chrome_fill_or_select', [target(args)]);
    case 'chrome_keyboard':
      return d('chrome_keyboard', [target(args)]);
    case 'chrome_upload_file':
      return d('chrome_upload_file', [target(args)]);
    case 'chrome_read_page':
      return args.filter === 'interactive'
        ? d('chrome_read_page_interactive')
        : d('chrome_read_page_visible');
    case 'chrome_get_page_text':
      return d('chrome_get_page_text', [target(args)]);
    case 'chrome_spa_fetch':
      return d('chrome_spa_fetch', [
        compact(args.url) || target(args),
        String(args.maxScrolls || 5),
      ]);
    case 'chrome_extract':
      return d('chrome_extract', [target(args)]);
    case 'chrome_scroll': {
      const container = compact(args.containerSelector);
      if (args.toBottom)
        return container ? d('chrome_scroll_bottom_in', [container]) : d('chrome_scroll_bottom');
      if (args.toTop)
        return container ? d('chrome_scroll_top_in', [container]) : d('chrome_scroll_top');
      if (args.scrollIntoView) return d('chrome_scroll_into_view', [target(args)]);
      const direction = String(args.direction || d('chrome_scroll_down'));
      const amount = String(args.amount || 300);
      return container
        ? d('chrome_scroll_by_in', [container, direction, amount])
        : d('chrome_scroll_by', [direction, amount]);
    }
    case 'chrome_navigate':
      return d('chrome_navigate', [compact(args.url) || d('chrome_navigate_fallback')]);
    case 'chrome_network_capture':
      return args.action === 'start'
        ? d('chrome_network_capture_start')
        : d('chrome_network_capture_stop');
    case 'chrome_block_images':
      return args.action === 'start'
        ? d('chrome_block_images_start')
        : d('chrome_block_images_stop');
    case 'chrome_network_capture_start':
    case 'chrome_network_debugger_start':
      return d('chrome_network_capture_start');
    case 'chrome_network_capture_stop':
    case 'chrome_network_debugger_stop':
      return d('chrome_network_capture_stop');
    case 'chrome_network_request':
      return d('chrome_network_request', [String(args.method || 'GET')]);
    case 'chrome_history': {
      const text = compact(args.text);
      return text ? d('chrome_history_query', [text]) : d('chrome_history');
    }
    case 'chrome_bookmark_search': {
      const query = compact(args.query);
      return query ? d('chrome_bookmark_search_query', [query]) : d('chrome_bookmark_search');
    }
    case 'chrome_bookmark_add':
      return d('chrome_bookmark_add');
    case 'chrome_bookmark_delete':
      return d('chrome_bookmark_delete');
    case 'chrome_handle_dialog':
      return args.action === 'accept'
        ? d('chrome_handle_dialog_accept')
        : d('chrome_handle_dialog_dismiss');
    case 'chrome_handle_download': {
      const action = compact(args.action);
      return action ? d('chrome_handle_download_action', [action]) : d('chrome_handle_download');
    }
    case 'chrome_computer':
      return d('chrome_computer', [
        compact(args.action) || d('chrome_computer_fallback'),
        target(args),
      ]);
    case 'chrome_post_to_x':
      return d('chrome_post_to_x', [compact(args.text, 60) || d('chrome_post_to_x_fallback')]);
    case 'chrome_javascript':
      return d('chrome_javascript');
    case 'chrome_paste_text':
      return d('chrome_paste_text', [target(args)]);
    case 'chrome_console':
      return d('chrome_console');
    case 'chrome_userscript':
      return d('chrome_userscript', [compact(args.action) || d('chrome_userscript_fallback')]);
    case 'performance_start_trace':
      return args.reload ? d('performance_start_trace_reload') : d('performance_start_trace');
    case 'performance_stop_trace':
      return d('performance_stop_trace');
    case 'performance_analyze_insight':
      return d('performance_analyze_insight');
    case 'chrome_gif_recorder': {
      const action = compact(args.action) || d('chrome_gif_recorder_fallback');
      return args.durationMs
        ? d('chrome_gif_recorder_duration', [action, duration(args.durationMs, 0)])
        : d('chrome_gif_recorder', [action]);
    }
    case 'chrome_get_tab_url':
      return d('chrome_get_tab_url');
    case 'chrome_proxy_rotate': {
      const reason = compact(args.reason);
      return reason ? d('chrome_proxy_rotate_reason', [reason]) : d('chrome_proxy_rotate');
    }
    case 'chrome_get_scroll_state':
      return d('chrome_get_scroll_state');
    default:
      return '';
  }
}

type OperationState = 'running' | 'done' | 'failed';

interface OverlayLabels {
  colon: string;
  semicolon: string;
  click: string;
  expand: string;
  collapse: string;
  scrollTo: string;
  target: Record<string, string>;
}

/**
 * The injected function renames the action once the DOM tells it what the
 * element really is, and a page has no access to chrome.i18n — so every string
 * it may need is resolved here and passed in.
 */
function overlayLabels(): OverlayLabels {
  return {
    colon: t('ovColon'),
    semicolon: t('ovSemicolon'),
    click: t('ovClick'),
    expand: t('ovExpand'),
    collapse: t('ovCollapse'),
    scrollTo: t('ovScrollTo'),
    target: {
      chrome_fill_or_select: t('ovTarget_chrome_fill_or_select'),
      chrome_extract: t('ovTarget_chrome_extract'),
      chrome_get_page_text: t('ovTarget_chrome_get_page_text'),
      chrome_spa_fetch: t('ovTarget_chrome_spa_fetch'),
      chrome_screenshot: t('ovTarget_chrome_screenshot'),
      chrome_upload_file: t('ovTarget_chrome_upload_file'),
    },
  };
}

async function showOperation(param: ToolCallParam, state: OperationState) {
  const tabId = param.args?.tabId;
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab =
      typeof tabId === 'number'
        ? await chrome.tabs.get(tabId)
        : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  } catch {
    return;
  }
  if (!tab?.id) return;

  // The overlay is best-effort; only pass primitives so malformed tool input cannot block the tool.
  const selector =
    compact(param.args?.selector) ||
    (param.name === 'chrome_scroll' ? compact(param.args?.containerSelector) : '') ||
    null;
  const coordinates = param.args?.coordinates;
  const safeCoordinates =
    typeof coordinates?.x === 'number' &&
    Number.isFinite(coordinates.x) &&
    typeof coordinates?.y === 'number' &&
    Number.isFinite(coordinates.y)
      ? { x: coordinates.x, y: coordinates.y }
      : null;
  const intent = compact(param.args?.intent, 160) || null;
  const labels = overlayLabels();
  const stateText = t(
    state === 'running' ? 'ovStateRunning' : state === 'done' ? 'ovStateDone' : 'ovStateFailed',
  );
  const head = `${stateText}${labels.colon}${actionLabel(param.name)}`;
  const intentLine = intent ? `\n${t('ovIntent')}${labels.colon}${intent}` : '';

  try {
    await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        ...(typeof param.args?.frameId === 'number' ? { frameIds: [param.args.frameId] } : {}),
      },
      args: [
        param.name,
        selector,
        compact(param.args?.ref) || null,
        safeCoordinates,
        head,
        operationDetail(param),
        intentLine,
        state === 'running',
        labels,
        param.name === 'chrome_scroll' && !!param.args?.scrollIntoView,
      ],
      func: (
        name: string,
        selector: string | null,
        ref: string | null,
        coordinates: { x: number; y: number } | null,
        head: string,
        detail: string,
        intentLine: string,
        isRunning: boolean,
        labels: {
          colon: string;
          semicolon: string;
          click: string;
          expand: string;
          collapse: string;
          scrollTo: string;
          target: Record<string, string>;
        },
        scrollIntoView: boolean,
      ) => {
        const statusId = '__mcp_operation_status__';
        const highlightId = '__mcp_operation_highlight__';
        const root = document.documentElement || document.body;
        let status = document.getElementById(statusId);
        if (!status) {
          status = document.createElement('div');
          status.id = statusId;
          Object.assign(status.style, {
            position: 'fixed',
            left: '16px',
            bottom: '16px',
            zIndex: '2147483647',
            padding: '8px 12px',
            borderRadius: '8px',
            background: 'rgba(17, 24, 39, .9)',
            color: '#fff',
            font: '13px/1.4 system-ui, sans-serif',
            whiteSpace: 'pre-line',
            maxWidth: '360px',
            pointerEvents: 'none',
            boxShadow: '0 4px 14px rgba(0,0,0,.25)',
          });
          root.append(status);
        }
        let target: Element | null = null;
        try {
          target = selector ? document.querySelector(String(selector)) : null;
        } catch {}
        if (!target && ref) {
          const map = (window as any).__claudeElementMap;
          const value = map instanceof Map ? map.get(ref) : map?.[ref];
          target =
            value instanceof Element
              ? value
              : value?.element instanceof Element
                ? value.element
                : null;
        }
        const elementName = target
          ? [
              target.getAttribute('aria-label'),
              target.getAttribute('title'),
              target.textContent?.trim().replace(/\s+/g, ' '),
            ]
              .find((value) => value)
              ?.slice(0, 72)
          : '';
        if (elementName && (name === 'chrome_click_element' || name === 'chrome_click_and_wait')) {
          const expanded = target?.getAttribute('aria-expanded');
          const action =
            expanded === 'false'
              ? labels.expand
              : expanded === 'true'
                ? labels.collapse
                : labels.click;
          const separator = String(detail).indexOf(labels.semicolon);
          const wait =
            name === 'chrome_click_and_wait' && separator >= 0
              ? String(detail).slice(separator)
              : '';
          detail = `${action}${labels.colon}${elementName}${wait}`;
        } else if (elementName && name === 'chrome_scroll' && scrollIntoView) {
          detail = `${labels.scrollTo}${labels.colon}${elementName}`;
        } else if (elementName && labels.target[name]) {
          detail = `${labels.target[name]}${labels.colon}${elementName}`;
        }
        status.textContent = `${head}${detail ? `\n${detail}` : ''}${intentLine}`;

        const rect = target?.getBoundingClientRect();
        const x = rect?.left ?? Number((coordinates as any)?.x);
        const y = rect?.top ?? Number((coordinates as any)?.y);
        const width = rect?.width ?? ((coordinates as any) ? 28 : 0);
        const height = rect?.height ?? ((coordinates as any) ? 28 : 0);
        let highlight = document.getElementById(highlightId);
        if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
          if (!highlight) {
            highlight = document.createElement('div');
            highlight.id = highlightId;
            Object.assign(highlight.style, {
              position: 'fixed',
              zIndex: '2147483646',
              pointerEvents: 'none',
              border: '3px solid #f97316',
              borderRadius: '5px',
              background: 'rgba(249,115,22,.12)',
              boxShadow: '0 0 0 2px rgba(255,255,255,.9)',
            });
            root.append(highlight);
          }
          Object.assign(highlight.style, {
            left: `${x}px`,
            top: `${y}px`,
            width: `${width}px`,
            height: `${height}px`,
            display: 'block',
          });
        }
        const key = '__mcpOperationOverlayTimer__';
        clearTimeout((window as any)[key]);
        if (!isRunning)
          (window as any)[key] = setTimeout(() => {
            status?.remove();
            highlight?.remove();
          }, 1800);
      },
    });
  } catch {
    // Status rendering must never turn a successful tool call into a failure.
  }
}

async function checkExpectedUrl(param: ToolCallParam): Promise<string | null> {
  const expectedUrl = String(param.args?.expectedUrl || '');
  if (!expectedUrl) return null;
  const tabId = param.args?.tabId;
  const tab =
    typeof tabId === 'number'
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.url?.startsWith(expectedUrl))
    return `Expected URL prefix ${expectedUrl}, got ${tab?.url || 'none'}`;
  return null;
}

/**
 * Handle tool execution
 */
export const handleCallTool = async (
  param: ToolCallParam,
  signal?: AbortSignal,
  reportProgress?: ToolProgressReporter,
) => {
  const tool = toolsMap.get(param.name);
  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  try {
    if (signal?.aborted) return createErrorResponse('Tool call cancelled');
    const urlError = await checkExpectedUrl(param);
    if (urlError) return createErrorResponse(urlError);
    const args = { ...(param.args || {}) };
    if (args.background === undefined && param.name !== 'chrome_spa_fetch') {
      const { backgroundOperations = true } =
        await chrome.storage.local.get('backgroundOperations');
      args.background = backgroundOperations;
    }
    await showOperation(param, 'running');
    const result = reportProgress
      ? await tool.execute(args, signal, reportProgress)
      : await tool.execute(args, signal);
    void showOperation(param, result.isError ? 'failed' : 'done');
    return result;
  } catch (error) {
    void showOperation(param, 'failed');
    console.error(`Tool execution failed for ${param.name}:`, error);
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  }
};
