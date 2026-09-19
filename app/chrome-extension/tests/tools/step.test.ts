/**
 * chrome_step safety boundaries.
 *
 * The point of these tests is not that the tool clicks the right thing — that
 * needs a real page. It is that a decision the tool cannot stand behind never
 * reaches the page at all: no Input.* command is dispatched when the model
 * answers with something outside the offered options, or when the page moved
 * under the decision.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendCommand = vi.fn();
const withSession = vi.fn(async (_tabId: number, _owner: string, fn: () => Promise<unknown>) =>
  fn(),
);

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    sendCommand: (...args: unknown[]) => sendCommand(...args),
    withSession: (...args: any[]) => withSession(...(args as [number, string, any])),
  },
}));

const { buildActionSpace, stepTool, validateChoice } =
  await import('@/entrypoints/background/tools/browser/step');

const TAB = { id: 7, url: 'https://example.com/', windowId: 1 };

/** Two buttons and one text field, as SNAPSHOT_JS would report them. */
const SNAPSHOT = {
  url: TAB.url,
  title: 'Fixture',
  text: 'Cancel Save Name',
  scroll: { y: 0, height: 800 },
  actions: [
    { id: 'e1', node: 1, kind: 'click', role: 'button', label: 'Cancel', value: '' },
    { id: 'e2', node: 2, kind: 'click', role: 'button', label: 'Save', value: '' },
    { id: 'e3', node: 3, kind: 'fill', role: 'textbox', label: 'Name', value: '' },
  ],
  marker: ['marker'],
  pageKey: ['key'],
  guards: { '1': ['g1'], '2': ['g2'], '3': ['g3'] },
  omitted: 0,
};

function answer(choice: string, probabilities: Record<string, number>, confidence = 0.9) {
  return { type: 'choice', choice, probabilities, confidence };
}

/** A model reply whose target head picks `target` out of `targetIds`. */
function modelReply(operation: string, target: string, targetIds: string[]) {
  const spread = (ids: string[], winner: string) =>
    Object.fromEntries(
      ids.map((id) => [id, id === winner ? 1 - 0.01 * (ids.length - 1) : 0.01]),
    ) as Record<string, number>;
  const operations = ['CLICK', 'TYPE_TEXT', 'DONE', 'BLOCKED'];
  return {
    model: 'jev-test',
    answers: {
      operation: answer(operation, spread(operations, operation)),
      [`${operation.toLowerCase()}_target`]: answer(target, spread(targetIds, target)),
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

/** Drive one chrome_step call against a canned model reply. */
async function runStep(reply: unknown, resolveResult: unknown = { x: 40, y: 50 }) {
  (globalThis as any).chrome.tabs.get = vi.fn().mockResolvedValue(TAB);
  sendCommand.mockImplementation(async (_tabId: number, method: string, params: any) => {
    if (method !== 'Runtime.evaluate') return {};
    const isSnapshot = !String(params.expression).includes('input.pageKey');
    return { result: { value: isSnapshot ? SNAPSHOT : resolveResult } };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => reply }),
  );

  const result = await stepTool.execute({
    goal: 'save the form',
    text: 'Ada',
    tabId: TAB.id,
    _typesafeApiKey: 'test-key',
    _typesafeBaseUrl: 'https://model.test/v1',
  });
  return JSON.parse(textOf(result));
}

/** MCP content blocks are a union; every result here is a text block. */
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

const inputCommands = () =>
  sendCommand.mock.calls.filter(([, method]) => String(method).startsWith('Input.'));

beforeEach(() => {
  sendCommand.mockReset();
});

describe('validateChoice', () => {
  const ids = ['e1', 'e2'];

  it('accepts a well-formed distribution over the offered options', () => {
    expect(validateChoice(answer('e2', { e1: 0.1, e2: 0.9 }), ids).choice).toBe('e2');
  });

  it('rejects a choice that was never offered', () => {
    expect(() => validateChoice(answer('e9', { e1: 0.1, e2: 0.9 }), ids)).toThrow(/Invalid model/);
  });

  it('rejects a distribution whose keys are not the offered options', () => {
    expect(() => validateChoice(answer('e1', { e1: 0.5, e9: 0.5 }), ids)).toThrow(/Invalid model/);
    expect(() => validateChoice(answer('e1', { e1: 1 }), ids)).toThrow(/Invalid model/);
  });

  it('rejects probabilities that are not finite values in [0,1]', () => {
    expect(() => validateChoice(answer('e1', { e1: 1.4, e2: -0.4 }), ids)).toThrow(/Invalid model/);
    expect(() => validateChoice(answer('e1', { e1: NaN, e2: 1 }), ids)).toThrow(/Invalid model/);
    // Confidence is held to the same range as the probabilities.
    expect(() => validateChoice(answer('e1', { e1: 0.6, e2: 0.4 }, 2), ids)).toThrow(
      /Invalid model/,
    );
  });

  it('rejects a distribution that does not sum to 1', () => {
    expect(() => validateChoice(answer('e1', { e1: 0.6, e2: 0.6 }), ids)).toThrow(/Invalid model/);
    expect(() => validateChoice(answer('e1', { e1: 0.2, e2: 0.2 }), ids)).toThrow(/Invalid model/);
  });

  it('rejects a choice that is not the most likely option', () => {
    expect(() => validateChoice(answer('e1', { e1: 0.2, e2: 0.8 }), ids)).toThrow(/Invalid model/);
  });

  it('tolerates rounding but not a real gap', () => {
    expect(validateChoice(answer('e1', { e1: 0.505, e2: 0.5 }), ids).choice).toBe('e1');
    expect(() => validateChoice(answer('e1', { e1: 0.53, e2: 0.5 }), ids)).toThrow(/Invalid model/);
  });
});

describe('buildActionSpace', () => {
  it('gives one row per element and lists every operation it supports', () => {
    const { elements, targets } = buildActionSpace([
      ...SNAPSHOT.actions,
      { id: 'e4', node: 3, kind: 'click', role: 'textbox', label: 'Open Name', value: '' },
    ] as any);

    expect(elements.map((e) => e.label)).toEqual(['Cancel', 'Save', 'Name']);
    expect(elements[2].operations).toEqual(['TYPE_TEXT', 'CLICK']);
    expect(Object.keys(targets.CLICK)).toEqual(['1', '2', '3']);
    expect(Object.keys(targets.TYPE_TEXT)).toEqual(['3']);
    // Indices address DOM nodes this code observed, not positions in the reply.
    expect(targets.TYPE_TEXT['3'].node).toBe(3);
  });
});

describe('chrome_step execution boundary', () => {
  it('clicks the element the model chose', async () => {
    const payload = await runStep(modelReply('CLICK', '2', ['1', '2']));

    expect(payload.executed).toBe(true);
    expect(payload.target.label).toBe('Save');
    expect(inputCommands().map(([, method]) => method)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
  });

  it('refuses an id that is not in the element table, and dispatches nothing', async () => {
    const reply = modelReply('CLICK', '2', ['1', '2']);
    // A target outside the offered enum: the id space the model was given is
    // the only id space the executor will resolve.
    reply.answers.click_target = answer('e999', { '1': 0.1, '2': 0.9 });

    const payload = await runStep(reply);

    expect(payload.success).toBe(false);
    expect(payload.refused).toBe('invalid_response');
    expect(inputCommands()).toHaveLength(0);
  });

  it('re-observes once when the page drifted, then acts', async () => {
    (globalThis as any).chrome.tabs.get = vi.fn().mockResolvedValue(TAB);
    let resolves = 0;
    sendCommand.mockImplementation(async (_tabId: number, method: string, params: any) => {
      if (method !== 'Runtime.evaluate') return {};
      if (!String(params.expression).includes('input.pageKey'))
        return { result: { value: SNAPSHOT } };
      // First pass sees drift; the second pass, taken from a fresh snapshot, does not.
      resolves += 1;
      return { result: { value: resolves === 1 ? { reject: 'page changed' } : { x: 5, y: 6 } } };
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => modelReply('CLICK', '2', ['1', '2']),
      }),
    );

    const result = await stepTool.execute({
      goal: 'save the form',
      tabId: TAB.id,
      _typesafeApiKey: 'test-key',
      _typesafeBaseUrl: 'https://model.test/v1',
    });
    const payload = JSON.parse(textOf(result));

    expect(payload.executed).toBe(true);
    expect(payload.retried).toBe(true);
    expect(inputCommands()).toHaveLength(2);
  });

  it('refuses when the page changed after the decision, and dispatches nothing', async () => {
    const payload = await runStep(modelReply('CLICK', '2', ['1', '2']), {
      reject: 'element or its surrounding context changed since the decision',
    });

    expect(payload.success).toBe(false);
    expect(payload.refused).toBe('stale');
    expect(payload.reason).toContain('changed since the decision');
    expect(inputCommands()).toHaveLength(0);
  });

  it('asks the caller for text instead of inventing one', async () => {
    (globalThis as any).chrome.tabs.get = vi.fn().mockResolvedValue(TAB);
    sendCommand.mockImplementation(async () => ({ result: { value: SNAPSHOT } }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => modelReply('TYPE_TEXT', '3', ['3']),
      }),
    );

    const result = await stepTool.execute({
      goal: 'enter the name',
      tabId: TAB.id,
      _typesafeApiKey: 'test-key',
      _typesafeBaseUrl: 'https://model.test/v1',
    });
    const payload = JSON.parse(textOf(result));

    expect(payload.refused).toBe('needs_text');
    expect(payload.reason).toContain('Name');
    expect(inputCommands()).toHaveLength(0);
  });

  it('refuses to run at all without a configured key', async () => {
    const result = await stepTool.execute({ goal: 'do something', tabId: TAB.id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('TYPESAFE_API_KEY');
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
