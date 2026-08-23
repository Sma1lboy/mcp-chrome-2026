<template>
  <main class="rove" :data-state="state">
    <header class="head rise" style="--i: 0">
      <img class="mark" :src="markUrl" alt="" width="28" height="28" />
      <h1 class="word">Rove</h1>
      <span
        class="pill"
        :data-tone="state === 'connected' ? 'ok' : state === 'hostOnly' ? 'warn' : 'off'"
      >
        <i class="dot" />{{ statusText }}
      </span>
    </header>

    <section class="hero rise" style="--i: 1">
      <div class="count">
        <span class="num">{{ state === 'connected' ? sessions : '—' }}</span>
        <span class="num-label">{{ agentsText }}</span>
      </div>
      <div class="meta mono">
        <span v-if="version">v{{ version }}</span>
        <span>:{{ serverStatus.port || port }}</span>
      </div>
    </section>

    <section class="block rise" style="--i: 2">
      <div class="label">{{ t('endpointLabel') }}</div>
      <code class="endpoint">{{ endpointUrl }}</code>
      <div class="actions">
        <button class="ghost" @click="copy('config')">{{
          copied === 'config' ? t('copied') : t('copyConfig')
        }}</button>
        <button class="ghost" @click="copy('url')">{{
          copied === 'url' ? t('copied') : t('copyUrl')
        }}</button>
      </div>
    </section>

    <section v-if="state === 'connected'" class="block rise" style="--i: 3">
      <div class="label">{{ t('recentCalls') }}</div>
      <ul v-if="calls.length" class="calls">
        <li v-for="c in calls" :key="c.requestId" class="call" :data-outcome="c.outcome">
          <i class="dot" />
          <span class="mono name">{{ c.name }}</span>
          <span class="mono tab" v-if="c.tabId != null">#{{ c.tabId }}</span>
          <span class="mono when">{{ ago(c.startedAt) }}</span>
        </li>
      </ul>
      <p v-else class="empty">{{ t('noCalls') }}</p>
    </section>

    <p v-else-if="state === 'disconnected'" class="hint rise" style="--i: 3">{{
      t('hintDisconnected')
    }}</p>

    <section class="controls rise" style="--i: 4">
      <label class="field">
        <span class="label">{{ t('portLabel') }}</span>
        <span class="port mono">
          <span class="host">127.0.0.1:</span>
          <input
            v-model.number="port"
            type="number"
            min="1024"
            max="65535"
            :disabled="state === 'connected' || state === 'hostOnly'"
            @change="savePort"
          />
        </span>
      </label>
      <label class="field switch">
        <span>{{ t('backgroundTabs') }}</span>
        <input type="checkbox" v-model="backgroundTabs" @change="saveBackground" />
        <i />
      </label>
      <button v-if="state === 'hostOnly'" class="primary" @click="startService">{{
        t('startService')
      }}</button>
      <button v-else class="primary" :disabled="state === 'connecting'" @click="toggleConnection">
        {{ state === 'connected' ? t('disconnect') : t('connect') }}
      </button>
    </section>

    <footer class="foot rise" style="--i: 5">
      <a :href="docsUrl" target="_blank" rel="noreferrer">{{ t('docs') }} ↗</a>
      <span class="mono">{{ extensionId }}</span>
    </footer>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { NativeMessageType } from '@ethanwilkins/chrome-mcp-shared-2026';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { LINKS } from '@/common/constants';
import { getMessage as t } from '@/utils/i18n';

type Host = 'unknown' | 'connected' | 'disconnected';
interface ToolCall {
  requestId: string;
  name: string;
  startedAt: string;
  outcome: 'running' | 'success' | 'error';
  tabId?: number;
}

const markUrl = chrome.runtime.getURL('icon/48.png');
const extensionId = chrome.runtime.id;
const docsUrl = LINKS.TROUBLESHOOTING;

const host = ref<Host>('unknown');
const connecting = ref(false);
const serverStatus = ref<{ isRunning: boolean; port?: number }>({ isRunning: false });
const port = ref(12306);
const backgroundTabs = ref(true);
const version = ref('');
const sessions = ref(0);
const calls = ref<ToolCall[]>([]);
const copied = ref<'config' | 'url' | ''>('');

const state = computed(() => {
  if (connecting.value || host.value === 'unknown') return 'connecting';
  if (host.value === 'disconnected') return 'disconnected';
  return serverStatus.value.isRunning ? 'connected' : 'hostOnly';
});
const statusText = computed(
  () =>
    ({
      connecting: t('statusConnecting'),
      disconnected: t('statusDisconnected'),
      hostOnly: t('statusHostOnly'),
      connected: t('statusConnected'),
    })[state.value],
);
const agentsText = computed(() =>
  state.value !== 'connected' || sessions.value === 0
    ? t('agentsNone')
    : sessions.value === 1
      ? t('agentsOnlineOne')
      : t('agentsOnline', [String(sessions.value)]),
);
const endpointUrl = computed(() => `http://127.0.0.1:${serverStatus.value.port || port.value}/mcp`);

const send = (message: Record<string, unknown>) =>
  chrome.runtime.sendMessage(message).catch(() => null);

async function refreshStatus() {
  const res = await send({ type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS });
  if (!res) return;
  host.value = res.connected ? 'connected' : 'disconnected';
  if (res.serverStatus) serverStatus.value = res.serverStatus;
}

async function pollServer() {
  if (state.value !== 'connected') return;
  try {
    const s = await fetch(`http://127.0.0.1:${serverStatus.value.port || port.value}/status`).then(
      (r) => r.json(),
    );
    version.value = s?.server?.version ?? '';
    sessions.value = s?.mcp?.activeSessions ?? 0;
    calls.value = (s?.recentToolCalls ?? []).slice(0, 6);
  } catch {
    // server went away between polls; the status listener will flip state
  }
}

async function toggleConnection() {
  connecting.value = true;
  try {
    if (host.value === 'connected') {
      await send({ type: NativeMessageType.DISCONNECT_NATIVE });
    } else {
      await send({ type: NativeMessageType.CONNECT_NATIVE, port: port.value });
    }
  } finally {
    connecting.value = false;
    await refreshStatus();
  }
}

async function startService() {
  await send({ type: BACKGROUND_MESSAGE_TYPES.START_NATIVE_SERVER, port: port.value });
  await refreshStatus();
}

async function copy(kind: 'config' | 'url') {
  const text =
    kind === 'url'
      ? endpointUrl.value
      : JSON.stringify(
          { mcpServers: { rove: { type: 'streamable-http', url: endpointUrl.value } } },
          null,
          2,
        );
  await navigator.clipboard.writeText(text);
  copied.value = kind;
  setTimeout(() => (copied.value = ''), 1500);
}

const savePort = () => chrome.storage.local.set({ nativeServerPort: port.value });
const saveBackground = () =>
  chrome.storage.local.set({ backgroundOperations: backgroundTabs.value });

function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

const onMessage = (m: { type?: string; payload?: unknown }) => {
  if (m?.type === BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED && m.payload) {
    serverStatus.value = m.payload as { isRunning: boolean; port?: number };
    void pollServer();
  }
};
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  const stored = await chrome.storage.local.get(['nativeServerPort', 'backgroundOperations']);
  if (typeof stored.nativeServerPort === 'number') port.value = stored.nativeServerPort;
  backgroundTabs.value = stored.backgroundOperations !== false;
  chrome.runtime.onMessage.addListener(onMessage);
  await refreshStatus();
  await pollServer();
  timer = setInterval(pollServer, 2500);
});
onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onMessage);
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.rove {
  padding: 18px 18px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.rise {
  animation: rise 420ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
  animation-delay: calc(var(--i) * 45ms);
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mark {
  border-radius: 7px;
}
.word {
  margin: 0;
  font: 500 22px/1 var(--serif);
  letter-spacing: -0.01em;
  flex: 1;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px 4px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 12px;
  color: var(--ink-soft);
  background: var(--panel);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}
.pill[data-tone='ok'] .dot {
  background: var(--ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
}
.pill[data-tone='warn'] .dot {
  background: var(--warn);
}

.hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 4px 0 2px;
  border-bottom: 1px solid var(--line-strong);
}
.count {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.num {
  font: 400 46px/0.9 var(--serif);
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.num-label {
  color: var(--ink-soft);
  font-size: 13px;
}
.meta {
  display: flex;
  gap: 10px;
  color: var(--muted);
  font-size: 11px;
  padding-bottom: 4px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.label {
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}
.endpoint {
  display: block;
  padding: 9px 11px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
  color: var(--ink);
  overflow-x: auto;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 8px;
}
.ghost {
  padding: 5px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  color: var(--ink-soft);
  transition:
    background 120ms,
    color 120ms;
}
.ghost:hover {
  background: var(--panel);
  color: var(--ink);
}

.calls {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.call {
  display: grid;
  grid-template-columns: 7px 1fr auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11.5px;
  border-top: 1px solid var(--line);
}
.call:first-child {
  border-top: 0;
}
.call[data-outcome='success'] .dot {
  background: var(--ok);
}
.call[data-outcome='error'] .dot {
  background: var(--bad);
}
.call[data-outcome='running'] .dot {
  background: var(--warn);
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab,
.when {
  color: var(--muted);
}
.empty,
.hint {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.hint {
  padding: 10px 12px;
  border-left: 2px solid var(--warn);
  background: var(--panel);
  border-radius: 0 8px 8px 0;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
  border-top: 1px solid var(--line);
}
.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.port {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  padding-left: 8px;
}
.port .host {
  color: var(--muted);
  font-size: 12px;
}
.port input {
  width: 64px;
  border: 0;
  background: transparent;
  font: 12.5px var(--mono);
  color: var(--ink);
  padding: 6px 8px 6px 2px;
  outline: none;
}
.port input:disabled {
  color: var(--muted);
}
.switch {
  position: relative;
  cursor: pointer;
}
.switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.switch i {
  width: 30px;
  height: 18px;
  border-radius: 999px;
  background: var(--line-strong);
  position: relative;
  transition: background 140ms;
  flex: none;
}
.switch i::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--panel);
  transition: transform 140ms;
}
.switch input:checked + i {
  background: var(--ok);
}
.switch input:checked + i::after {
  transform: translateX(12px);
}
.primary {
  margin-top: 2px;
  padding: 9px 12px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-ink);
  font: 500 13px var(--serif);
  cursor: pointer;
  transition:
    transform 100ms,
    opacity 100ms;
}
.primary:hover {
  transform: translateY(-1px);
}
.primary:disabled {
  opacity: 0.5;
  cursor: default;
  transform: none;
}

.foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: var(--muted);
}
.foot a {
  color: var(--ink-soft);
  text-decoration: none;
}
.foot a:hover {
  text-decoration: underline;
}
.foot .mono {
  font-size: 10px;
  opacity: 0.7;
}
</style>
