<p align="center">
  <img src="app/chrome-extension/public/icon/128.png" alt="Rove" width="80" height="80" />
</p>
<h1 align="center">Rove in Chrome</h1>
<p align="center">An MCP bridge that hands your own Chrome to agents. Logged-in sessions, cookies, extensions, a real browser fingerprint — no headless browser on the side.</p>
<p align="center"><a href="README.md">中文</a></p>

---

## What it is

A Chrome extension plus a local native host. Agents connect over MCP (`http://127.0.0.1:12306/mcp`) and get 160+ browser tools: navigate, read pages, click and fill, screenshots, network capture, cookies, bookmarks and history, performance traces, semantic search across tabs — all inside **the Chrome you are already using**.

Several agents can be connected at once. Tabs an agent opens land in its own tab group (named after the MCP client), it never steals your focus, and `chrome_workspace cleanup` closes the group when it is done.

## Install

**1. Extension**: download `rove-in-chrome-*-chrome.zip` from [Releases](https://github.com/Sma1lboy/mcp-chrome-2026/releases/latest), unzip, then `chrome://extensions/` → Developer mode → load the unzipped folder (or `app/chrome-extension/.output/chrome-mv3` if you build it yourself).

**2. Native host**

```bash
# the .tgz from the same Release; it must match the extension version. The npm @ethanwilkins/mcp-chrome-bridge-2026 is upstream's and speaks a different protocol
npm install -g ./ethanwilkins-mcp-chrome-bridge-2026-<version>.tgz
mcp-chrome-bridge register   # npm 11 skips postinstall by default, so register once by hand
```

**3. Connect**: click the extension icon → Connect. The popup shows the endpoint, connected agents and recent tool calls; “Copy config” gives you a paste-ready MCP entry.

## Point an agent at it

```json
{
  "mcpServers": {
    "rove": { "type": "streamable-http", "url": "http://127.0.0.1:12306/mcp" }
  }
}
```

stdio alternative: `{"command": "mcp-chrome-stdio"}` (one process per harness, proxied to the same HTTP server).

## Workspace isolation

The MCP client's `clientInfo.name` picks the tab group and colour: `claude-code` → `claude` (orange), `Codex CLI` → `codex` (blue), `gemini` (green), `kimi` (purple), `opencode` (cyan); other names are used as-is. Precedence: explicit `workspace` argument > session client name > `MCP_WORKSPACE` env > `agent`; `workspace: ""` opts out.

`chrome_navigate` defaults to `background: true`; reusing an already-open tab returns `reusedExistingTab: true`, `reuseExisting: false` forces a new one. Call `chrome_workspace` `cleanup` when the task is over.

## Develop

```bash
pnpm install
pnpm -C app/chrome-extension build     # extension → .output/chrome-mv3
pnpm -C app/native-server build        # native host → dist/
pnpm -C app/native-server test
```

Server status: `curl http://127.0.0.1:12306/status` (sessions, recent tool calls, extension connectivity).

More: [architecture](docs/ARCHITECTURE.md) · [contributing](docs/CONTRIBUTING.md) · [changelog](docs/CHANGELOG.md)

## License

MIT
