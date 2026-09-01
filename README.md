<p align="center">
  <img src="app/chrome-extension/public/icon/128.png" alt="Rove" width="80" height="80" />
</p>
<h1 align="center">Rove in Chrome</h1>
<p align="center">把你自己的 Chrome 暴露给 agent 的 MCP 桥。登录态、cookies、扩展、真实的浏览器指纹——agent 直接用，不用再开一个无头浏览器。</p>
<p align="center"><a href="README_en.md">English</a></p>

---

## 它是什么

一个 Chrome 扩展 + 一个本地 native host。agent 通过 MCP（`http://127.0.0.1:12306/mcp`）连进来，拿到 160+ 个浏览器工具：导航、读页、点击填表、截图、网络抓包、cookie、书签历史、性能 trace、语义搜索标签页……全部跑在**你正在用的那个 Chrome** 里。

多个 agent 可以同时连。每个 agent 开的标签页自动归进自己的 tab group（按 MCP 客户端名分组），不抢你的焦点，收工时 `chrome_workspace cleanup` 一键收摊。

## 安装

**1. 扩展**：从 [Releases](https://github.com/Sma1lboy/mcp-chrome-2026/releases/latest) 下载 `rove-in-chrome-*-chrome.zip` 解压，`chrome://extensions/` → 开发者模式 → 加载解压后的目录（自己构建则加载 `app/chrome-extension/.output/chrome-mv3`）。

**2. Native host**

```bash
# 同一个 Release 里的 .tgz，和扩展版本必须一致；npm 上的 @ethanwilkins/mcp-chrome-bridge-2026 是上游版本，协议不兼容
npm install -g ./ethanwilkins-mcp-chrome-bridge-2026-<version>.tgz
mcp-chrome-bridge register   # npm 11 默认不跑 postinstall，手动注册一次
```

**3. 连接**：点扩展图标 → Connect。弹窗里显示端点、在线 agent 数和最近的工具调用，“复制配置”拿到可粘贴的 MCP 配置。

## 接入 agent

```json
{
  "mcpServers": {
    "rove": { "type": "streamable-http", "url": "http://127.0.0.1:12306/mcp" }
  }
}
```

stdio 备选：`{"command": "mcp-chrome-stdio"}`（每个 harness 独立进程，代理到同一个 HTTP 服务）。

## Workspace 隔离

MCP 握手时客户端上报 `clientInfo.name`，服务端据此分组并固定颜色：`claude-code` → `claude`（橙）、`Codex CLI` → `codex`（蓝）、`gemini`（绿）、`kimi`（紫）、`opencode`（青），其他名字原样使用。覆盖顺序：显式 `workspace` 参数 > session 客户端名 > 环境变量 `MCP_WORKSPACE` > `agent`；`workspace: ""` 表示退出分组。

`chrome_navigate` 默认 `background: true`，不抢焦点；复用已打开的同 URL 标签页时返回 `reusedExistingTab: true`，`reuseExisting: false` 强制新开。任务结束用 `chrome_workspace` 的 `cleanup` 关掉自己那一组。

## 开发

```bash
pnpm install
pnpm -C app/chrome-extension build     # 扩展 → .output/chrome-mv3
pnpm -C app/native-server build        # native host → dist/
pnpm -C app/native-server test
```

服务状态：`curl http://127.0.0.1:12306/status`（session 数、最近工具调用、扩展连接状态）。

更多：[架构](docs/ARCHITECTURE_zh.md) · [贡献](docs/CONTRIBUTING_zh.md) · [变更](docs/CHANGELOG.md)

## 许可证

MIT
