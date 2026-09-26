import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from '@ethanwilkins/chrome-mcp-shared-2026';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

interface SecretSinkParams {
  selector?: string;
  expression?: string;
  tabId?: number;
  windowId?: number;
}

/**
 * Read a raw, unsanitized value for chrome_secret_sink. The value rides in
 * `secret`, outside `content`; the native server writes it to a file or a
 * command's stdin and strips it before anything reaches the MCP client.
 */
class SecretSinkTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SECRET_SINK;

  async execute(args: SecretSinkParams): Promise<ToolResult> {
    const selector = args?.selector?.trim();
    const expression = args?.expression?.trim();
    if (!selector === !expression)
      return createErrorResponse('Provide exactly one of selector or expression');

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) return createErrorResponse('Target tab has no ID');
      const code = selector
        ? `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('Element not found');
            return 'value' in el ? String(el.value ?? '') : String(el.textContent ?? '').trim();
          })()`
        : `(async () => (${expression}))()`;
      const response = await cdpSessionManager.withSession(tab.id, 'secret-sink', () =>
        cdpSessionManager.sendCommand(tab.id!, 'Runtime.evaluate', {
          expression: code,
          returnByValue: true,
          awaitPromise: true,
        }),
      );
      // Never echo the exception text: it could quote the value.
      if (response?.exceptionDetails)
        return createErrorResponse('Reading the value threw in the page');
      const value = response?.result?.value;
      if (typeof value !== 'string' || !value)
        return createErrorResponse('Value is empty or not a string');
      return {
        content: [{ type: 'text', text: 'secret read' }],
        isError: false,
        secret: value,
      } as ToolResult;
    } catch (error) {
      return createErrorResponse(
        `Secret read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const secretSinkTool = new SecretSinkTool();
