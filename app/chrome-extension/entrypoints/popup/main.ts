import { createApp } from 'vue';
import { NativeMessageType } from '@ethanwilkins/chrome-mcp-shared-2026';
import './style.css';
import App from './App.vue';

// Nudge the background to (re)connect the native host; the UI polls status itself.
void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {});
createApp(App).mount('#app');
