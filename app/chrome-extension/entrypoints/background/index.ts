import { initNativeHostListener } from './native-host';
import {
  initSemanticSimilarityListener,
  initializeSemanticEngineIfCached,
} from './semantic-similarity';
import { initStorageManagerListener } from './storage-manager';
import { cleanupModelCache } from '@/utils/semantic-similarity-engine';
import { initElementMarkerListeners } from './element-marker';
import { initErrorLog } from './error-log';
import { initProxyManager } from './proxy';

/**
 * Background entry: Rove is the MCP bridge between agents and this browser.
 * Everything here either talks to the native host or backs an MCP tool.
 */
export default defineBackground(() => {
  initErrorLog();
  initProxyManager();
  initNativeHostListener();
  initSemanticSimilarityListener();
  initStorageManagerListener();
  // Element markers back chrome_locate_element / read_page / interaction tools.
  initElementMarkerListeners();

  initializeSemanticEngineIfCached().catch((error) => {
    console.warn('Background: semantic engine init from cache failed:', error);
  });
  cleanupModelCache().catch((error) => {
    console.warn('Background: model cache cleanup failed:', error);
  });
});
