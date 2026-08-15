// Produce the Chrome Web Store screenshots with the real extension.
//
// Two images, both 1280x800, both generated rather than staged:
//
//   1. what-it-does  — the visible viewport beside the full-page capture the
//      extension actually produced from it, at the same moment
//   2. settings      — the options page, which is the whole UI
//
// The subject is `tests/fixtures/demo.html`, our own content. A store listing
// that screenshots someone else's site ships their branding in our marketing.

import { mkdirSync, rmSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { attach, waitForTarget, sleep } from '../tests/e2e/chrome.js';
import { browserFactory, instrumented, withServer } from '../tests/e2e/fixture.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist/store');
const withBrowser = browserFactory(9800);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const shot = async (browser, sessionId, path, clip) => {
  const { data } = await browser.conn.send(
    'Page.captureScreenshot',
    { format: 'png', ...(clip ? { clip } : {}) },
    sessionId,
  );
  writeFileSync(path, Buffer.from(data, 'base64'));
  return path;
};

await withServer(8798, async (origin) => {
  await withBrowser(
    [instrumented('jsi-shots')],
    async (browser) => {
      const id = browser.ids[0];
      const worker = await attach(browser, (await waitForTarget(browser, id)).id);
      const page = (await browser.targets()).find((t) => t.type === 'page');
      const { sessionId } = await browser.conn.send('Target.attachToTarget', {
        targetId: page.id,
        flatten: true,
      });

      // A 1280x800 viewport is the store's own screenshot size, so the
      // "before" is exactly what a reader of the listing would see.
      await browser.conn.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false },
        sessionId,
      );

      await browser.conn.send('Page.navigate', { url: `${origin}/demo.html` }, sessionId);
      await sleep(2500);
      await shot(browser, sessionId, join(OUT, 'raw-viewport.png'));

      await worker.evaluate(`
        await chrome.storage.local.set({ copyToClipboard: false });
        await chrome.storage.local.remove('lastCapture');
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        globalThis.__test_startRun(tab);
        return true;`);

      let record = null;
      for (let i = 0; i < 90 && !record; i += 1) {
        await sleep(500);
        ({ lastCapture: record } = await worker.evaluate(
          `return await chrome.storage.local.get('lastCapture');`,
        ));
      }
      if (!record || record.state !== 'complete') {
        throw new Error(`the capture did not complete: ${JSON.stringify(record)}`);
      }
      // Copied out now, not later: the throwaway profile and its download
      // directory are removed when this process exits.
      if (!existsSync(record.saved)) throw new Error(`no file at ${record.saved}`);
      cpSync(record.saved, join(OUT, 'raw-fullpage.png'));

      // The options page: the extension's only UI.
      await browser.conn.send(
        'Page.navigate',
        { url: `chrome-extension://${id}/src/options.html` },
        sessionId,
      );
      await sleep(2000);
      await shot(browser, sessionId, join(OUT, 'raw-options.png'));
    },
    { headless: true },
  );
});

for (const f of ['raw-viewport.png', 'raw-options.png', 'raw-fullpage.png']) {
  const p = join(OUT, f);
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  console.log(`  ${f}  ${execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', p])
    .toString().trim().split('\n').slice(1).map((l) => l.split(': ')[1]).join('x')}`);
}
