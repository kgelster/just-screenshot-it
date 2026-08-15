// Drive a real Chrome over the DevTools Protocol with this extension loaded.
//
// Extension pages and the toolbar button are both out of reach for ordinary
// browser automation, which for a while made every fix here unverifiable and
// turned debugging into blind round trips. This closes that gap: a throwaway
// profile, the extension loaded into it, and a handle on its service worker.
//
// Node 18+ ships a WebSocket client, so this needs no dependencies.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();

async function waitForPort(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await json(port, '/json/version');
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Chrome never opened the debugging port ${port}`);
}

/** One WebSocket, many CDP sessions, multiplexed by sessionId. */
class Conn {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 60000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Launch Chrome and load unpacked extensions, in order.
 *
 * Order is load-bearing: Chrome settles competing `onDeterminingFilename`
 * suggestions by install recency, so the last entry wins arbitration.
 *
 * `--load-extension` is not used. Chrome 137 removed it from branded builds;
 * the CDP `Extensions.loadUnpacked` command replaced it, and it derives the
 * same extension id from the directory path that "Load unpacked" would.
 */
export async function launch({ extensions = [], port = 9333, profileDir, downloadDir, headless = true }) {
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(join(profileDir, 'Default'), { recursive: true });
  mkdirSync(downloadDir, { recursive: true });

  // Through Preferences rather than CDP's Browser.setDownloadBehavior, which
  // takes over download handling and would be a second influence on the
  // filename — the exact thing under test.
  writeFileSync(
    join(profileDir, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloadDir, prompt_for_download: false },
      savefile: { default_directory: downloadDir },
      profile: { exit_type: 'Normal', exited_cleanly: true },
    }),
  );

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1280,900',
  ];
  if (headless) args.push('--headless=new');
  args.push('about:blank');

  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  const version = await waitForPort(port);
  const conn = await connect(version.webSocketDebuggerUrl);
  await conn.send('Target.setDiscoverTargets', { discover: true });

  const ids = [];
  for (const path of extensions) ids.push((await conn.send('Extensions.loadUnpacked', { path })).id);
  if (ids.length) await sleep(1200);

  return {
    ids,
    conn,
    port,
    downloadDir,
    targets: () => json(port, '/json/list'),
    async close() {
      conn.close();
      proc.kill('SIGKILL');
      await sleep(300);
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true });
  });
  return new Conn(ws);
}

/** Wait for a target whose URL contains `match`. */
export async function waitForTarget(browser, match, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = (await browser.targets()).find((t) => t.url.includes(match));
    if (hit) return hit;
    await sleep(300);
  }
  const seen = (await browser.targets()).map((t) => `${t.type} ${t.url}`).join('\n  ');
  throw new Error(`no target matching "${match}". Saw:\n  ${seen}`);
}

/** Attach to a target and return `evaluate`, which awaits promises for you. */
export async function attach(browser, targetId) {
  const { sessionId } = await browser.conn.send('Target.attachToTarget', { targetId, flatten: true });
  const logs = [];
  browser.conn.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(
        `${msg.params.type}: ${msg.params.args
          .map((a) => (a.value !== undefined ? JSON.stringify(a.value) : a.description || a.type))
          .join(' ')}`,
      );
    }
  });
  await browser.conn.send('Runtime.enable', {}, sessionId);
  return {
    logs,
    async evaluate(expression) {
      const res = await browser.conn.send(
        'Runtime.evaluate',
        { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result.value;
    },
  };
}
