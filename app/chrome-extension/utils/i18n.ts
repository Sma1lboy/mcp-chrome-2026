/**
 * chrome.i18n with an English fallback for contexts where the API is missing.
 * zh_CN/messages.json is the source of truth; keep this map and every locale in sync.
 */
const fallbackMessages: Record<string, string> = {
  extensionName: 'Rove',
  extensionDescription: 'Rove in Chrome',
  statusConnected: 'Connected',
  statusDisconnected: 'Not connected',
  statusConnecting: 'Connecting…',
  statusHostOnly: 'Host connected, service not started',
  endpointLabel: 'MCP endpoint',
  copyConfig: 'Copy config',
  copyUrl: 'Copy URL',
  copied: 'Copied',
  agentsOnline: '{0} agents connected',
  agentsOnlineOne: '1 agent connected',
  agentsNone: 'No agent connected',
  recentCalls: 'Recent tool calls',
  noCalls: 'No tool calls yet',
  portLabel: 'Port',
  backgroundTabs: 'Open agent tabs in the background',
  connect: 'Connect',
  disconnect: 'Disconnect',
  startService: 'Start service',
  hintDisconnected: 'Native host is not responding. Install and register it, then connect.',
  docs: 'Docs',
  bookmarksBarLabel: 'Bookmarks Bar',
};

export function getMessage(key: string, substitutions?: string[]): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage) {
      const message = chrome.i18n.getMessage(key, substitutions);
      if (message) return message;
    }
  } catch (error) {
    console.warn(`Failed to get i18n message for key "${key}":`, error);
  }
  let fallback = fallbackMessages[key] || key;
  substitutions?.forEach((value, index) => {
    fallback = fallback.replace(`{${index}}`, value);
  });
  return fallback;
}

export function isI18nAvailable(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function'
    );
  } catch {
    return false;
  }
}
