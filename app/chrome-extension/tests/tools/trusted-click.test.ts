import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { attach, detach, sendCommand } = vi.hoisted(() => ({
  attach: vi.fn(async () => {}),
  detach: vi.fn(async () => {}),
  sendCommand: vi.fn(async (_tabId: number, _method: string, _params?: any) => ({})),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: { attach, detach, sendCommand },
}));

import { trustedClick } from '@/entrypoints/background/tools/browser/interaction';

const focusCalls = () =>
  sendCommand.mock.calls
    .filter((c) => c[1] === 'Emulation.setFocusEmulationEnabled')
    .map((c) => c[2].enabled);

describe('trustedClick focus hold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('returns without waiting, then releases focus and the session once', async () => {
    await trustedClick(1, 10, 10, 'left', 1, undefined);
    expect(focusCalls()).toEqual([true]);
    expect(detach).not.toHaveBeenCalled();

    // A second click inside the hold reuses the session and restarts the hold.
    await vi.advanceTimersByTimeAsync(200);
    await trustedClick(1, 10, 10, 'left', 1, undefined);
    await vi.advanceTimersByTimeAsync(200);
    expect(detach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(focusCalls()).toEqual([true, true, false]);
  });

  it('releases immediately when the click fails', async () => {
    sendCommand.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(trustedClick(2, 10, 10, 'left', 1, undefined)).rejects.toThrow('boom');
    expect(detach).toHaveBeenCalledTimes(1);
  });
});

import { compactElementInfo } from '@/entrypoints/background/tools/browser/interaction';
import { compactInteractiveElement } from '@/entrypoints/background/tools/browser/web-fetcher';

describe('compact tool replies', () => {
  it('keeps what identifies the element and anything unusual, drops the rest', () => {
    const info = {
      tagName: 'BUTTON',
      id: 'go',
      className: '',
      href: null,
      isVisible: true,
      isHitTestVisible: false,
      matchCount: 1,
      rect: { x: 1.5 },
      value: 'x',
      clickMethod: 'selector',
    };
    expect(compactElementInfo(info)).toEqual({
      tagName: 'BUTTON',
      id: 'go',
      isHitTestVisible: false,
      value: 'x',
    });
  });

  it('rounds coordinates and leaves the rect out unless asked for', () => {
    const el = {
      type: 'link',
      selector: 'a',
      text: 'Team',
      isInteractive: true,
      disabled: false,
      role: null,
      coordinates: {
        x: 148.04,
        y: 149.92,
        rect: { x: 130.6, y: 141.4, width: 34.8, height: 16.8 },
      },
    };
    expect(compactInteractiveElement(el, false)).toEqual({
      type: 'link',
      selector: 'a',
      text: 'Team',
      coordinates: { x: 148, y: 150 },
    });
    expect((compactInteractiveElement(el, true).coordinates as any).rect).toEqual({
      x: 131,
      y: 141,
      width: 35,
      height: 17,
    });
  });
});
