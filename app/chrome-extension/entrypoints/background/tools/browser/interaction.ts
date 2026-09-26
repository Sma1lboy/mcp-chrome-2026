import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from '@ethanwilkins/chrome-mcp-shared-2026';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { listMarkersForUrl } from '@/entrypoints/background/element-marker/element-marker-storage';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

interface Coordinates {
  x: number;
  y: number;
}

interface ClickToolParams {
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  markerId?: string; // Persisted element marker id
  markerName?: string; // Persisted element marker name
  ref?: string; // Element ref from accessibility tree (window.__claudeElementMap)
  coordinates?: Coordinates; // Coordinates to click at (x, y relative to viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

function normalizeMarkerName(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function frameIdsFor(frameId?: number): number[] | undefined {
  return typeof frameId === 'number' ? [frameId] : undefined;
}

async function findMarkerForTab(tab: chrome.tabs.Tab, markerId?: string, markerName?: string) {
  const id = String(markerId || '').trim();
  const name = normalizeMarkerName(markerName);
  if (!id && !name) return null;

  const markers = await listMarkersForUrl(String(tab.url || ''));
  if (id) {
    const marker = markers.find((item) => item.id === id);
    if (!marker) throw new Error(`Element marker "${id}" was not found for the current URL`);
    return marker;
  }

  const matches = markers.filter((item) => normalizeMarkerName(item.name) === name);
  if (matches.length > 1) {
    throw new Error(`Element marker name "${markerName}" matched multiple markers; use markerId`);
  }
  if (!matches[0])
    throw new Error(`Element marker "${markerName}" was not found for the current URL`);
  return matches[0];
}

const MODIFIER_BITS = { altKey: 1, ctrlKey: 2, metaKey: 4, shiftKey: 8 } as const;
const CDP_BUTTONS = { left: 1, right: 2, middle: 4 } as const;

/**
 * Click through CDP Input.dispatchMouseEvent. Unlike DOM-dispatched events these
 * are isTrusted and grant user activation, which popups (window.open) and
 * navigator.clipboard require. Focus emulation stays on through a short grace
 * period: agent tabs sit in the background, and the clipboard API rejects
 * writes from an unfocused document.
 */
async function trustedClick(
  tabId: number,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  clickCount: number,
  modifiers: ClickToolParams['modifiers'],
): Promise<void> {
  let mask = 0;
  for (const [key, bit] of Object.entries(MODIFIER_BITS))
    if (modifiers?.[key as keyof typeof MODIFIER_BITS]) mask |= bit;
  const base = { x: Math.round(x), y: Math.round(y), modifiers: mask };
  await cdpSessionManager.withSession(tabId, 'trusted-click', async () => {
    const send = (method: string, params: object) =>
      cdpSessionManager.sendCommand(tabId, method, params);
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
      await send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' });
      for (let i = 1; i <= clickCount; i++) {
        const press = { ...base, button, clickCount: i };
        await send('Input.dispatchMouseEvent', {
          ...press,
          type: 'mousePressed',
          buttons: CDP_BUTTONS[button],
        });
        await send('Input.dispatchMouseEvent', { ...press, type: 'mouseReleased', buttons: 0 });
      }
      // ponytail: fixed grace for async clipboard writes; raise if a site copies later.
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    }
  });
}

/**
 * Collect tabs/windows that `sourceTabId` opens (window.open, target=_blank)
 * so the click result can hand the agent their tabIds. A popup window cannot
 * join a tab group, so without this the agent has no way to find it.
 */
function watchOpenedTabs(sourceTabId: number) {
  const opened: Array<{ tabId: number; url: string }> = [];
  const listener = (d: chrome.webNavigation.WebNavigationSourceCallbackDetails) => {
    if (d.sourceTabId === sourceTabId) opened.push({ tabId: d.tabId, url: d.url });
  };
  const stop = () => chrome.webNavigation.onCreatedNavigationTarget.removeListener(listener);
  chrome.webNavigation.onCreatedNavigationTarget.addListener(listener);
  // Error paths return without collecting; don't leak the listener.
  setTimeout(stop, 60_000);
  return async (graceMs: number) => {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    stop();
    return Promise.all(
      opened.map(async (o) => {
        const tab = await chrome.tabs.get(o.tabId).catch(() => undefined);
        const win = tab && (await chrome.windows.get(tab.windowId).catch(() => undefined));
        return { ...o, windowId: tab?.windowId, windowType: win?.type };
      }),
    );
  };
}

function waitForTabLoading(tabId: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(value);
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'loading') done(true);
    };
    const timer = setTimeout(() => done(false), timeout);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      coordinates,
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;

    console.log(`Starting click operation with options:`, args);

    if (!selector && !coordinates && !args.ref && !args.markerId && !args.markerName) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS +
          ': Provide markerId, markerName, ref, selector, or coordinates',
      );
    }

    try {
      // Resolve tab. An explicit tabId is authoritative and must not fall back
      // to an unrelated active tab when the tab has been closed.
      const tab = await this.resolveTargetTab(args.tabId, args.windowId);
      if (typeof tab.id !== 'number') {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      const marker = await findMarkerForTab(tab, args.markerId, args.markerName);
      let finalRef = args.ref;
      let finalSelector = marker?.selector || selector;
      let finalSelectorType = marker?.selectorType || selectorType;

      if (marker) {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          true,
          frameIdsFor(frameId),
        );
        const located = await this.sendMessageToTab(
          tab.id,
          {
            action: 'locateElement',
            selector: marker.selector,
            selectorType: marker.selectorType || 'css',
            allowMultiple: !!marker.listMode,
            scrollIntoView: true,
            highlight: false,
          },
          frameId,
        );
        if (!located?.success || !located.ref) {
          return createErrorResponse(located?.error || `Failed to locate marker "${marker.id}"`);
        }
        finalRef = located.ref;
      }

      // If selector is XPath, convert to ref first
      if (finalSelector && finalSelectorType === 'xpath') {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          frameIdsFor(frameId),
        );
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector: finalSelector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            // Keep the XPath as a recovery hint. The injected helper receives
            // selectorType and can re-resolve it if a framework replaces the
            // DOM node after this lookup.
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // A ref is an ephemeral DOM handle. Resolve its current selector so the
      // content script can recover if the page re-renders between lookup and
      // click. This also gives marker/ref-only calls a useful fallback.
      if (finalRef && !finalSelector) {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          frameIdsFor(frameId),
        );
        const resolved = await this.sendMessageToTab(
          tab.id,
          { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref: finalRef },
          frameId,
        );
        if (resolved?.success && typeof resolved.selector === 'string') {
          finalSelector = resolved.selector;
          finalSelectorType = 'css';
        }
      }

      if (!coordinates && !finalRef && !finalSelector) {
        return createErrorResponse(
          ERROR_MESSAGES.INVALID_PARAMETERS +
            ': Click target could not be resolved; provide a fresh ref or selector',
        );
      }

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/click-helper.js'],
        false,
        'ISOLATED',
        false,
        frameIdsFor(frameId),
      );

      // Main-frame clicks resolve the target in the page, then click with
      // trusted CDP input. Subframe coordinates are frame-relative, so those
      // keep the DOM dispatch path.
      const wantTrusted = typeof frameId !== 'number' || frameId === 0;
      const collectOpened = watchOpenedTabs(tab.id);
      const sendClick = (resolveOnly: boolean) =>
        this.sendMessageToTab(
          tab.id!,
          {
            action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
            selector: finalSelector,
            coordinates,
            ref: finalRef,
            waitForNavigation,
            timeout,
            selectorType: finalSelectorType,
            double: args.double === true,
            button,
            bubbles,
            cancelable,
            modifiers,
            resolveOnly,
          },
          frameId,
        );

      let result = await sendClick(wantTrusted);
      let trusted = false;
      if (result?.resolveOnly) {
        const navigation = waitForNavigation ? waitForTabLoading(tab.id, timeout) : undefined;
        try {
          await trustedClick(
            tab.id,
            result.clickX,
            result.clickY,
            button || 'left',
            args.double ? 2 : 1,
            modifiers,
          );
          trusted = true;
          result = { ...result, navigationOccurred: navigation ? await navigation : false };
        } catch (error) {
          // Debugger unavailable (e.g. DevTools is attached): fall back to DOM events.
          console.warn('Trusted click failed, falling back to DOM dispatch:', error);
          result = await sendClick(false);
        }
      }

      if (!result || result.error || result.success === false) {
        return createErrorResponse(
          result?.error || 'Click operation did not report a successful click',
        );
      }
      const openedTabs = await collectOpened(trusted ? 300 : 500);

      // Determine actual click method used
      let clickMethod: string;
      if (coordinates) {
        clickMethod = 'coordinates';
      } else if (finalRef) {
        clickMethod = marker ? 'marker' : 'ref';
      } else if (finalSelector) {
        clickMethod = 'selector';
      } else {
        clickMethod = 'unknown';
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Click operation successful',
              elementInfo: result.elementInfo,
              navigationOccurred: result.navigationOccurred,
              clickMethod,
              trusted,
              ...(openedTabs.length ? { openedTabs } : {}),
              markerId: marker?.id,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in click operation:', error);
      return createErrorResponse(
        `Error performing click: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  markerId?: string;
  markerName?: string;
  ref?: string; // Element ref from accessibility tree
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
  timeout?: number; // Timeout in milliseconds for waiting for the element
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      ref,
      value,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
    } = args;

    console.log(`Starting fill operation with options:`, args);

    if (!selector && !ref && !args.markerId && !args.markerName) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide markerId, markerName, ref, or selector',
      );
    }

    if (value === undefined || value === null) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Value must be provided');
    }

    try {
      const tab = await this.resolveTargetTab(args.tabId, args.windowId);
      if (typeof tab.id !== 'number') {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      const marker = await findMarkerForTab(tab, args.markerId, args.markerName);
      let finalRef = ref;
      let finalSelector = marker?.selector || selector;
      let finalSelectorType = marker?.selectorType || selectorType;

      if (marker) {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          true,
          frameIdsFor(frameId),
        );
        const located = await this.sendMessageToTab(
          tab.id,
          {
            action: 'locateElement',
            selector: marker.selector,
            selectorType: marker.selectorType || 'css',
            allowMultiple: !!marker.listMode,
            scrollIntoView: true,
            highlight: false,
          },
          frameId,
        );
        if (!located?.success || !located.ref) {
          return createErrorResponse(located?.error || `Failed to locate marker "${marker.id}"`);
        }
        finalRef = located.ref;
      }

      // If selector is XPath, convert to ref first
      if (finalSelector && finalSelectorType === 'xpath') {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          frameIdsFor(frameId),
        );
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector: finalSelector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            // Keep the XPath as a recovery hint for DOM replacement.
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Recover a selector from a live ref before filling. The selector is
      // sent alongside the ref so fill-helper can recover after re-render.
      if (finalRef && !finalSelector) {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          frameIdsFor(frameId),
        );
        const resolved = await this.sendMessageToTab(
          tab.id,
          { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref: finalRef },
          frameId,
        );
        if (resolved?.success && typeof resolved.selector === 'string') {
          finalSelector = resolved.selector;
          finalSelectorType = 'css';
        }
      }

      if (!finalRef && !finalSelector) {
        return createErrorResponse(
          ERROR_MESSAGES.INVALID_PARAMETERS +
            ': Fill target could not be resolved; provide a fresh ref or selector',
        );
      }

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/fill-helper.js'],
        false,
        'ISOLATED',
        false,
        frameIdsFor(frameId),
      );

      // Send fill message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
          selector: finalSelector,
          selectorType: finalSelectorType,
          ref: finalRef,
          timeout,
          value,
        },
        frameId,
      );

      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Fill operation successful',
              elementInfo: result.elementInfo,
              markerId: marker?.id,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.warn('Error in fill operation:', error);
      return createErrorResponse(
        `Error filling element: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const fillTool = new FillTool();
