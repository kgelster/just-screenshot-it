// The "it only works once" regression suite.
//
//     npm run test:e2e
//
// The extension captured exactly once per browser session. Every attempt after
// the first was refused with "Could not start the capture: the previous one is
// still finishing", and only restarting Chrome cleared it. The cause was one
// promise that never settled:
//
//     const img = new Image();
//     img.src = blobUrl;
//     await img.decode();          // <- never resolves in an offscreen document
//
// Recorded behaviour, measured on Chrome 151.0.7922.138 / macOS 15, in both
// headed and headless runs:
//
//   * An offscreen document is never rendered. `requestAnimationFrame` never
//     fires in one, and `HTMLImageElement.decode()` never settles — including
//     for a 1x1 PNG, so it is not a size or memory effect.
//   * The `load` event does fire there, which is the way out.
//   * `navigator.clipboard.write()` throws NotAllowedError, "Document is not
//     focused". An offscreen document cannot be focused, so this is permanent.
//   * `document.execCommand('copy')` over a selected, loaded `<img>` does
//     work there, and is therefore the only image-to-clipboard path available.
//
// The second test pins those four facts. If any of them changes in a later
// Chrome, the workaround in `src/offscreen.js` can be revisited — but only
// deliberately, not by accident.

import test from 'node:test';
import assert from 'node:assert';

import { attach, waitForTarget, sleep } from './chrome.js';
import { browserFactory, instrumented, withServer } from './fixture.js';

const withBrowser = browserFactory(9600);

/** Drive one capture and return the `lastCapture` record it wrote. */
async function captureOnce(worker, timeoutMs = 60000) {
  await worker.evaluate(`
    await chrome.storage.local.remove('lastCapture');
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    globalThis.__test_startRun(tab);
    return true;`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const { lastCapture } = await worker.evaluate(
      `return await chrome.storage.local.get('lastCapture');`,
    );
    if (lastCapture) return lastCapture;
  }
  return null;
}

test('three captures in a row all succeed', async () => {
  const jsi = instrumented('jsi-lifecycle');

  await withServer(8796, async (origin) => {
    await withBrowser([jsi], async (browser) => {
      const worker = await attach(browser, (await waitForTarget(browser, browser.ids[0])).id);
      const page = (await browser.targets()).find((t) => t.type === 'page');
      const { sessionId } = await browser.conn.send('Target.attachToTarget', {
        targetId: page.id,
        flatten: true,
      });
      await browser.conn.send('Page.navigate', { url: `${origin}/sticky.html` }, sessionId);
      await sleep(2500);

      const saved = [];
      for (let pass = 1; pass <= 3; pass += 1) {
        const record = await captureOnce(worker);
        assert.ok(record, `capture ${pass} never produced a download`);
        assert.strictEqual(record.state, 'complete', `capture ${pass} did not complete`);
        saved.push(record.saved);

        // Back to idle: a run left behind is what makes the *next* capture
        // report "a capture was already running".
        const active = await worker.evaluate('return globalThis.__test_run();');
        assert.strictEqual(active, null, `capture ${pass} left a run behind`);
        await sleep(1200); // distinct timestamps, so the filenames differ
      }

      assert.strictEqual(new Set(saved).size, 3, `expected three distinct files, got ${saved}`);
    });
  });
});

test('an offscreen document has no rendering pipeline', async () => {
  const jsi = instrumented('jsi-offscreen');

  await withBrowser([jsi], async (browser) => {
    const worker = await attach(browser, (await waitForTarget(browser, browser.ids[0])).id);
    await worker.evaluate(`
      await chrome.offscreen.createDocument({
        url: 'src/offscreen.html',
        reasons: ['BLOBS', 'CLIPBOARD'],
        justification: 'test',
      }).catch(() => {});
      return true;`);

    const off = await attach(browser, (await waitForTarget(browser, 'src/offscreen.html')).id);
    const facts = await off.evaluate(`
      const race = (p, ms) => Promise.race([
        p.then(() => 'settled', (e) => 'rejected: ' + e.name),
        new Promise((r) => setTimeout(() => r('never settled'), ms)),
      ]);

      const c = new OffscreenCanvas(1, 1);
      c.getContext('2d').fillRect(0, 0, 1, 1);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const url = URL.createObjectURL(blob);

      const raf = await race(new Promise((r) => requestAnimationFrame(r)), 2500);

      const a = new Image();
      a.src = url;
      const decode = await race(a.decode(), 2500);

      const b = new Image();
      const load = await race(
        new Promise((res, rej) => { b.onload = res; b.onerror = rej; b.src = url; }), 2500);

      const asyncClipboard = await race(
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]), 2500);

      // The path the extension actually uses.
      const holder = document.getElementById('clip');
      const img = new Image();
      img.src = url;
      await new Promise((r) => { img.onload = r; });
      holder.innerHTML = '';
      holder.appendChild(img);
      void img.offsetWidth;
      const range = document.createRange();
      range.selectNode(img);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      holder.focus();
      const execCommand = document.execCommand('copy');
      sel.removeAllRanges();
      holder.innerHTML = '';

      URL.revokeObjectURL(url);
      return { raf, decode, load, asyncClipboard, execCommand };`);

    assert.strictEqual(facts.raf, 'never settled', 'requestAnimationFrame now fires offscreen');
    assert.strictEqual(facts.decode, 'never settled', 'img.decode() now settles offscreen');
    assert.strictEqual(facts.load, 'settled', 'the load event stopped firing offscreen');
    assert.strictEqual(
      facts.asyncClipboard,
      'rejected: NotAllowedError',
      'navigator.clipboard.write() now works offscreen',
    );
    assert.strictEqual(facts.execCommand, true, 'execCommand("copy") stopped working offscreen');
  });
});
