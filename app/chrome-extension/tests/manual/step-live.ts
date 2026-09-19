/**
 * Live verification for chrome_step against a throwaway Chrome.
 *
 * Not part of `vitest run` (it needs a browser, a network call, and a key).
 * Run it by hand when touching the snapshot or the guard layers:
 *
 *   TYPESAFE_API_KEY=... npx tsx tests/manual/step-live.ts
 *
 * It launches its own Chrome on port 9333 with its own profile, so it never
 * touches the browser the operator is using. It imports the tool's real
 * readPage / buildRequest / readDecision / resolveAndDispatch; only the CDP
 * transport below is local to this script.
 *
 * Four checks, in order of how much they matter:
 *   3. out-of-table id  — a choice outside the offered enum must not execute
 *   2. stale page       — a page that changed after the decision must not execute
 *   1. right target     — the click lands on the element that was chosen
 *   4. real site        — a multi-step task on a live page, with timings
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CdpSend } from '@/entrypoints/background/tools/browser/step';

// The tool module pulls in the extension's CDP session manager, which registers
// a chrome.debugger listener at import time. Stub the two globals it touches,
// then import for real: the functions under test are the shipped ones.
(globalThis as any).chrome ??= {
  debugger: { onDetach: { addListener() {} } },
  runtime: { id: 'step-live' },
};
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: process.platform === 'darwin' ? 'Macintosh' : 'Linux' },
  configurable: true,
});

const { buildActionSpace, buildRequest, readDecision, readPage, resolveAndDispatch } =
  await import('@/entrypoints/background/tools/browser/step');

const PORT = 9333;
const PROFILE = '/tmp/step-chrome';
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

// ============================================================================
// Minimal CDP transport: one browser websocket, flattened target sessions.
// ============================================================================

class Cdp {
  private socket!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  sessionId?: string;

  static async connect(): Promise<Cdp> {
    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const cdp = new Cdp();
    cdp.socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      cdp.socket.onopen = resolve;
      cdp.socket.onerror = () => reject(new Error('CDP websocket failed'));
    });
    cdp.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = message.id && cdp.pending.get(message.id);
      if (!waiter) return;
      cdp.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    };
    return cdp;
  }

  send(method: string, params: object = {}, sessionId = this.sessionId): Promise<any> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async openTab(url: string): Promise<void> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' }, undefined);
    const { sessionId } = await this.send(
      'Target.attachToTarget',
      { targetId, flatten: true },
      undefined,
    );
    this.sessionId = sessionId;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 1120,
      height: 780,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 300; i++) {
      const state = await this.evaluate('document.readyState');
      if (state === 'complete') return;
      await sleep(50);
    }
    throw new Error(`Timed out loading ${url}`);
  }

  async evaluate(expression: string): Promise<any> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }

  /** The transport handed to the tool's own functions. */
  get asSend(): CdpSend {
    return (method, params) => this.send(method, params ?? {});
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Fixtures
// ============================================================================

/** A form whose buttons all look alike, so picking the right one means something. */
const FORM_FIXTURE = `<!doctype html><title>Step fixture</title>
<style>body{font:16px system-ui;padding:24px} button{margin:4px;padding:8px 16px}</style>
<h1>Account settings</h1>
<p id="log">nothing clicked</p>
<form>
  <label>Display name <input id="name" type="text" value="old placeholder name"></label>
  <label>Email <input id="email" type="email" value="a@b.c"></label>
  <div>
    <button type="button" onclick="log.textContent='archive'">Archive account</button>
    <button type="button" onclick="log.textContent='delete'">Delete account</button>
    <button type="button" onclick="log.textContent='cancel'">Cancel</button>
    <button type="button" onclick="log.textContent='save'">Save changes</button>
  </div>
</form>`;

/**
 * Same form, but it rewrites itself the moment the snapshot runs.
 *
 * Polling for `window.__chromeStep` makes the race deterministic: the cache
 * only exists once SNAPSHOT_JS has run, so the mutation always lands after the
 * decision was made from and before it is executed.
 */
const MUTATING_FIXTURE =
  FORM_FIXTURE +
  `<script>
  const timer = setInterval(() => {
    if (!window.__chromeStep) return;
    clearInterval(timer);
    const row = document.querySelector('form div');
    // Same buttons, reordered, with the labels shuffled onto other handlers.
    row.innerHTML = '<button type="button" onclick="log.textContent=\\'save\\'">Delete account</button>' +
      '<button type="button" onclick="log.textContent=\\'delete\\'">Save changes</button>';
  }, 5);
</script>`;

/**
 * Two identical "Choose" buttons; only the row text tells them apart.
 *
 * `mutate` runs the moment SNAPSHOT_JS has built its cache, and swaps the two
 * names without touching the button nodes. The chosen node is still connected
 * and still says "Choose", so identity alone cannot catch this — only the
 * guard's snapshot of the surrounding row can. Without it the step would click
 * the same button and pick the other person.
 */
const ROW_FIXTURE = (mutate: string) => `<!doctype html><title>Pick a person</title>
<style>body{font:16px system-ui;padding:24px} li{margin:8px}</style>
<h1>Assign the ticket</h1>
<p id="log">nothing clicked</p>
<ul>
  <li><span class="who">Alice Smith</span>
      <button type="button" onclick="log.textContent='alice'">Choose</button></li>
  <li><span class="who">Bob Jones</span>
      <button type="button" onclick="log.textContent='bob'">Choose</button></li>
</ul>
<label>Notes <input id="notes" type="text" value="none"></label>
<script>
  const timer = setInterval(() => {
    if (!window.__chromeStep) return;
    clearInterval(timer);
    ${mutate}
  }, 5);
</script>`;

/** Row context changes underneath intact button nodes. */
const SWAPPED_ROWS = ROW_FIXTURE(`
  const names = [...document.querySelectorAll('.who')];
  [names[0].textContent, names[1].textContent] = [names[1].textContent, names[0].textContent];
`);

/** Document-level state changes: an unrelated field's value moves. */
const CHANGED_FIELD = ROW_FIXTURE(`document.getElementById('notes').value = 'edited elsewhere';`);

/** Nothing changes; the same fixture must still be actionable. */
const STABLE_ROWS = ROW_FIXTURE('');

// ============================================================================
// The step, assembled from the tool's own parts
// ============================================================================

interface StepOptions {
  goal: string;
  text?: string;
  history?: string[];
  /** Corrupt the model reply before it is read, to test the contract check. */
  tamper?: (reply: any, targets: Record<string, Record<string, any>>) => void;
}

/** Mirrors the tool's single stale retry, for the live-site walk. */
async function stepWithRetry(cdp: Cdp, apiKey: string, options: StepOptions) {
  try {
    return { ...(await step(cdp, apiKey, options)), retried: false };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Refused to act')) throw error;
    return { ...(await step(cdp, apiKey, options)), retried: true };
  }
}

async function step(cdp: Cdp, apiKey: string, options: StepOptions) {
  const t0 = Date.now();
  const page = await readPage(cdp.asSend);
  if (!page) throw new Error('page still navigating');
  const snapshotMs = Date.now() - t0;

  const { elements, targets } = buildActionSpace(page.actions as any);
  const request = buildRequest(page, elements, targets, options.goal, {
    history: options.history,
    text: options.text,
  });

  const t1 = Date.now();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`model HTTP ${response.status}`);
  const reply = await response.json();
  const modelMs = Date.now() - t1;

  options.tamper?.(reply, targets);

  const decision = readDecision(reply, targets);
  const t2 = Date.now();
  if (decision.action) {
    await resolveAndDispatch(cdp.asSend, page, decision.action, options.text);
  }
  return {
    operation: decision.operation,
    label: decision.action?.label,
    target: decision.target,
    operationProbabilities: decision.operationAnswer.probabilities,
    targetProbabilities: decision.targetAnswer?.probabilities,
    confidence: decision.operationAnswer.confidence,
    elements: elements.length,
    snapshotMs,
    modelMs,
    actMs: Date.now() - t2,
    totalMs: Date.now() - t0,
  };
}

// ============================================================================
// Checks
// ============================================================================

const results: string[] = [];
function record(name: string, passed: boolean, detail: string) {
  results.push(`${passed ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`);
  console.log(`${passed ? '✓' : '✗'} ${name}: ${detail}`);
}

function fixtureUrl(name: string, html: string): string {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, html);
  return `file://${file}`;
}

async function main() {
  const apiKey = (process.env.TYPESAFE_API_KEY || '').trim();
  if (!apiKey) throw new Error('set TYPESAFE_API_KEY');

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await sleep(100);
    }
  }

  try {
    // --- 3. An id outside the offered enum must never reach the page. --------
    {
      const cdp = await Cdp.connect();
      await cdp.openTab(fixtureUrl('step-oob.html', FORM_FIXTURE));
      let thrown = '';
      try {
        await step(cdp, apiKey, {
          goal: 'save the changes to this account',
          tamper: (reply) => {
            const head = reply.answers.click_target;
            // A plausible-looking id that was never in the element table.
            head.choice = 'e999';
            head.probabilities = { ...head.probabilities, e999: 0 };
          },
        });
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      const log = await cdp.evaluate('document.getElementById("log").textContent');
      record(
        'out-of-table id rejected',
        thrown.includes('Invalid model response') && log === 'nothing clicked',
        `threw "${thrown}"; page log still "${log}"`,
      );
    }

    // --- 2. A page that changed after the decision must not be acted on. -----
    {
      const cdp = await Cdp.connect();
      await cdp.openTab(fixtureUrl('step-stale.html', MUTATING_FIXTURE));
      let thrown = '';
      try {
        await step(cdp, apiKey, { goal: 'save the changes to this account' });
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      const log = await cdp.evaluate('document.getElementById("log").textContent');
      record(
        'stale page rejected',
        thrown.includes('Refused to act') && log === 'nothing clicked',
        `threw "${thrown}"; page log still "${log}"`,
      );
    }

    // --- 2b. Same node, changed row: only the scope guard can catch this. ----
    for (const [name, html, expectReject] of [
      ['stale row context rejected', SWAPPED_ROWS, true],
      ['stale document state rejected', CHANGED_FIELD, true],
      ['unchanged page still acts', STABLE_ROWS, false],
    ] as const) {
      const cdp = await Cdp.connect();
      await cdp.openTab(fixtureUrl(`step-${name.replace(/\s+/g, '-')}.html`, html));
      let thrown = '';
      let chose = '';
      try {
        const outcome = await step(cdp, apiKey, { goal: 'assign the ticket to Bob Jones' });
        chose = outcome.label ?? '';
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      await sleep(100);
      const log = await cdp.evaluate('document.getElementById("log").textContent');
      record(
        name,
        expectReject
          ? thrown.includes('Refused to act') && log === 'nothing clicked'
          : !thrown && log === 'bob',
        expectReject
          ? `threw "${thrown}"; page log still "${log}"`
          : `clicked "${chose}"; page log "${log}"`,
      );
    }

    // --- 1. The click lands on the element that was chosen. ------------------
    {
      const cdp = await Cdp.connect();
      await cdp.openTab(fixtureUrl('step-click.html', FORM_FIXTURE));
      const outcome = await step(cdp, apiKey, { goal: 'save the changes to this account' });
      await sleep(100);
      const log = await cdp.evaluate('document.getElementById("log").textContent');
      record(
        'clicks the chosen element',
        log === 'save',
        `${outcome.operation} "${outcome.label}" p=${outcome.targetProbabilities?.[outcome.target!]?.toFixed(3)}; page log "${log}"; ${outcome.snapshotMs}ms snapshot + ${outcome.modelMs}ms model + ${outcome.actMs}ms act`,
      );

      // And typing goes into the field the caller named, replacing its value.
      const typed = await step(cdp, apiKey, {
        goal: 'set the display name to Ada Lovelace',
        text: 'Ada Lovelace',
        history: ['clicked Save changes'],
      });
      await sleep(100);
      const value = await cdp.evaluate('document.getElementById("name").value');
      record(
        'types into the chosen field',
        value === 'Ada Lovelace',
        `${typed.operation} "${typed.label}"; field now "${value}"; ${typed.totalMs}ms`,
      );
    }

    // --- 4. A real site, several steps, with timings. -------------------------
    {
      const cdp = await Cdp.connect();
      await cdp.openTab('https://en.wikipedia.org/wiki/Main_Page');
      const goal = 'search Wikipedia for "Gödel\'s incompleteness theorems" and open that article';
      const history: string[] = [];
      console.log(`\n--- live: ${goal}`);
      for (let i = 1; i <= 4; i++) {
        const outcome = await stepWithRetry(cdp, apiKey, {
          goal,
          text: "Gödel's incompleteness theorems",
          history: [...history],
        });
        console.log(
          `  step ${i}: ${outcome.operation}` +
            (outcome.label ? ` → "${outcome.label}"` : '') +
            ` | op p=${outcome.operationProbabilities[outcome.operation]?.toFixed(3)}` +
            (outcome.target
              ? ` target p=${outcome.targetProbabilities?.[outcome.target]?.toFixed(3)}`
              : '') +
            ` | ${outcome.elements} elements` +
            ` | ${outcome.snapshotMs}ms snapshot + ${outcome.modelMs}ms model + ${outcome.actMs}ms act = ${outcome.totalMs}ms` +
            (outcome.retried ? ' (re-observed once after page drift)' : ''),
        );
        if (!outcome.label) break;
        history.push(`${outcome.operation} ${outcome.label}`);
        await sleep(700);
      }
      const url = await cdp.evaluate('location.href');
      record(
        'real site task',
        decodeURIComponent(url).includes('incompleteness'),
        `landed on ${decodeURIComponent(url)}`,
      );
    }
  } finally {
    chrome.kill();
  }

  console.log('\n===== summary =====');
  for (const line of results) console.log(line);
  process.exit(results.some((line) => line.startsWith('FAIL')) ? 1 : 0);
}

void main();
