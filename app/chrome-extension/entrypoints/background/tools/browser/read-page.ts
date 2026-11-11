import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from '@ethanwilkins/chrome-mcp-shared-2026';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';
import { listMarkersForUrl } from '@/entrypoints/background/element-marker/element-marker-storage';

interface ReadPageStats {
  processed: number;
  included: number;
  durationMs: number;
}

interface ReadPageParams {
  url?: string;
  filter?: 'interactive'; // when omitted, return all visible elements
  depth?: number; // maximum DOM depth to traverse (0 = root only)
  refId?: string; // focus on subtree rooted at this refId
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  maxOutputBytes?: number;
  includeElements?: boolean; // also return the structured per-ref list (selector + rect)
}

function roundRect(rect: any) {
  if (!rect || typeof rect !== 'object') return rect;
  return Object.fromEntries(
    Object.entries(rect).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v]),
  );
}

const DEFAULT_MAX_OUTPUT_BYTES = 24_000;
const MAX_MAX_OUTPUT_BYTES = 200_000;

class ReadPageTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.READ_PAGE;

  // Execute read page
  async execute(args: ReadPageParams): Promise<ToolResult> {
    const { filter, depth, refId, url } = args || {};
    const requestedMaxOutputBytes = Number(args?.maxOutputBytes);
    const maxOutputBytes =
      Number.isFinite(requestedMaxOutputBytes) && requestedMaxOutputBytes > 0
        ? Math.min(Math.floor(requestedMaxOutputBytes), MAX_MAX_OUTPUT_BYTES)
        : DEFAULT_MAX_OUTPUT_BYTES;

    // Validate refId parameter
    const focusRefId = typeof refId === 'string' ? refId.trim() : '';
    if (refId !== undefined && !focusRefId) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: refId must be a non-empty string`,
      );
    }

    // Validate depth parameter
    const requestedDepth = depth === undefined ? undefined : Number(depth);
    if (requestedDepth !== undefined && (!Number.isInteger(requestedDepth) || requestedDepth < 0)) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: depth must be a non-negative integer`,
      );
    }

    // Track if user explicitly controlled the output (skip sparse heuristics)
    const userControlled = requestedDepth !== undefined || !!focusRefId;

    try {
      let tab = await this.resolveTargetTab(args?.tabId, args?.windowId);
      if (url) {
        if (typeof tab.id !== 'number') {
          return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Target tab has no ID');
        }
        await chrome.tabs.update(tab.id, { url });
        tab = await this.waitForTabReady(tab.id);
      }
      if (typeof tab.id !== 'number')
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');

      // Load any user-marked elements for this URL (priority hints)
      const currentUrl = String(tab.url || '');
      const userMarkers = currentUrl ? await listMarkersForUrl(currentUrl) : [];

      // Inject helper in ISOLATED world to enable chrome.runtime messaging
      // Inject into all frames to support same-origin iframe operations
      await this.injectContentScript(
        tab.id,
        ['inject-scripts/accessibility-tree-helper.js'],
        false,
        'ISOLATED',
        true,
      );

      // Ask content script to generate accessibility tree
      const resp = await this.sendMessageToTab(tab.id, {
        action: TOOL_MESSAGE_TYPES.GENERATE_ACCESSIBILITY_TREE,
        filter: filter || null,
        depth: requestedDepth,
        refId: focusRefId || undefined,
      });

      // Evaluate tree result and decide whether to fallback
      const treeOk = resp && resp.success === true;
      const pageContent: string =
        resp && typeof resp.pageContent === 'string' ? resp.pageContent : '';

      // Extract stats from response
      const stats: ReadPageStats | null =
        treeOk && resp?.stats
          ? {
              processed: resp.stats.processed ?? 0,
              included: resp.stats.included ?? 0,
              durationMs: resp.stats.durationMs ?? 0,
            }
          : null;

      const lines = pageContent
        ? pageContent.split('\n').filter((l: string) => l.trim().length > 0).length
        : 0;
      const refCount = Array.isArray(resp?.refMap) ? resp.refMap.length : 0;

      // Skip sparse heuristics when user explicitly controls output
      const isSparse = !userControlled && lines < 10 && refCount < 3;

      // Build user-marked elements for inclusion
      const markedElements = userMarkers.map((m) => ({
        id: m.id,
        name: m.name,
        selector: m.selector,
        selectorType: m.selectorType || 'css',
        urlMatch: { type: m.matchType, origin: m.origin, path: m.path },
        source: 'marker',
        priority: 'highest',
      }));

      // Helper to convert elements array to pageContent format
      const formatElementsAsPageContent = (elements: any[]): string => {
        const out: string[] = [];
        for (const e of elements || []) {
          const type = typeof e?.type === 'string' && e.type ? e.type : 'element';
          const rawText = typeof e?.text === 'string' ? e.text.trim() : '';
          const text =
            rawText.length > 0
              ? ` "${rawText.replace(/\s+/g, ' ').slice(0, 100).replace(/"/g, '\\"')}"`
              : '';
          const selector =
            typeof e?.selector === 'string' && e.selector ? ` selector="${e.selector}"` : '';
          const coords =
            e?.coordinates && Number.isFinite(e.coordinates.x) && Number.isFinite(e.coordinates.y)
              ? ` (x=${Math.round(e.coordinates.x)},y=${Math.round(e.coordinates.y)})`
              : '';
          out.push(`- ${type}${text}${selector}${coords}`);
          if (out.length >= 150) break;
        }
        return out.join('\n');
      };

      // Every character here lands in the agent's context, so the reply carries
      // the compact tree only. Fields that are empty or at their default are
      // left out, and the structured per-ref list (the same elements again, as
      // selector + rect) is opt-in.
      const dialogs = Array.isArray(resp?.dialogs) ? resp.dialogs : [];
      const overlays = Array.isArray(resp?.overlays) ? resp.overlays : [];
      const basePayload: Record<string, any> = {
        success: true,
        filter: filter || 'all',
        pageContent,
        viewport: treeOk ? resp.viewport : { width: null, height: null, dpr: null },
        refMapCount: refCount,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url || url || '',
        title: tab.title || '',
        ...(treeOk && isSparse ? { sparse: true } : {}),
        ...(requestedDepth !== undefined ? { depth: requestedDepth } : {}),
        ...(focusRefId ? { focus: { refId: focusRefId, found: treeOk } } : {}),
        ...(markedElements.length ? { markedElements } : {}),
        ...(dialogs.length ? { dialogs } : {}),
        ...(overlays.length ? { overlays } : {}),
        ...(args?.includeElements === true && treeOk
          ? {
              elements: (Array.isArray(resp?.refMap) ? resp.refMap : []).map((item: any) => ({
                ...item,
                rect: roundRect(item.rect),
              })),
            }
          : {}),
      };

      const serializePayload = (payload: Record<string, any>): string => {
        const originalPageContent = String(payload.pageContent || '');
        const originalPageContentBytes = new TextEncoder().encode(originalPageContent).length;
        let serialized = JSON.stringify(payload);
        if (new TextEncoder().encode(serialized).length <= maxOutputBytes) return serialized;

        let low = 0;
        let high = originalPageContent.length;
        let best = '';
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          payload.pageContent = originalPageContent.slice(0, mid);
          payload.outputTruncated = true;
          payload.originalPageContentBytes = originalPageContentBytes;
          serialized = JSON.stringify(payload);
          if (new TextEncoder().encode(serialized).length <= maxOutputBytes) {
            best = serialized;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        if (best) return best;

        payload.pageContent = '';
        payload.elements = Array.isArray(payload.elements) ? payload.elements.slice(0, 25) : [];
        payload.markedElements = Array.isArray(payload.markedElements)
          ? payload.markedElements.slice(0, 10)
          : [];
        payload.outputTruncated = true;
        payload.originalPageContentBytes = originalPageContentBytes;
        return JSON.stringify(payload);
      };

      // Normal path: return tree
      if (treeOk && !isSparse) {
        return {
          content: [{ type: 'text', text: serializePayload(basePayload) }],
          isError: false,
        };
      }

      // When refId is explicitly provided, do not fallback (refs are frame-local and may expire)
      if (focusRefId) {
        return createErrorResponse(resp?.error || `refId "${focusRefId}" not found or expired`);
      }

      // When user explicitly controls depth, do not override with fallback heuristics
      if (requestedDepth !== undefined) {
        return createErrorResponse(resp?.error || 'Failed to generate accessibility tree');
      }

      // Fallback path: try get_interactive_elements once
      try {
        await this.injectContentScript(tab.id, ['inject-scripts/interactive-elements-helper.js']);
        const fallback = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
          includeCoordinates: true,
        });

        if (fallback && fallback.success && Array.isArray(fallback.elements)) {
          const limited = fallback.elements.slice(0, 150);
          // Merge user markers at the front, de-duplicated by selector
          const markerEls = userMarkers.map((m) => ({
            id: m.id,
            type: 'marker',
            selector: m.selector,
            text: m.name,
            selectorType: m.selectorType || 'css',
            isInteractive: true,
            source: 'marker',
            priority: 'highest',
          }));
          const seen = new Set(markerEls.map((e) => e.selector));
          const merged = [...markerEls, ...limited.filter((e: any) => !seen.has(e.selector))];

          basePayload.fallbackUsed = true;
          basePayload.fallbackSource = 'get_interactive_elements';
          basePayload.reason = treeOk ? 'sparse_tree' : resp?.error || 'tree_failed';
          basePayload.elements = merged;
          basePayload.count = fallback.elements.length;
          if (!basePayload.pageContent) {
            basePayload.pageContent = formatElementsAsPageContent(merged);
          }

          return {
            content: [{ type: 'text', text: serializePayload(basePayload) }],
            isError: false,
          };
        }
      } catch (fallbackErr) {
        console.warn('read_page fallback failed:', fallbackErr);
      }

      // If we reach here, both tree (usable) and fallback failed
      return createErrorResponse(
        treeOk
          ? 'Accessibility tree is too sparse and fallback failed'
          : resp?.error || 'Failed to generate accessibility tree and fallback failed',
      );
    } catch (error) {
      console.error('Error in read page tool:', error);
      return createErrorResponse(
        `Error generating accessibility tree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const readPageTool = new ReadPageTool();
