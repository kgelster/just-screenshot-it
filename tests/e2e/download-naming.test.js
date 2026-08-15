// The filename regression suite.
//
// Three attempts at "captures land in Downloads under a UUID instead of the
// template" were shipped blind and two of them were wrong, because nothing
// here could be observed without asking a human to click a toolbar button and
// report back. These tests are what ended that.
//
// They launch a real Chrome, so they are not part of `npm test`:
//
//     npm run test:e2e
//
// Recorded behaviour, measured on Chrome 151.0.7922.138 / macOS 15:
//
//   * `downloads.download({filename})` is honoured — blob URL or data URL,
//     subfolders included — as long as NO extension has an
//     `onDeterminingFilename` listener registered.
//   * The moment any extension registers one, Chrome discards that `filename`
//     and falls back to a name derived from the URL: the UUID for a blob URL,
//     `download.png` for a data URL. Declining to suggest, calling bare
//     `suggest()`, and echoing `item.filename` all lose it. Only answering
//     with a real suggestion keeps it.
//   * `item.filename` in the event is Chrome's own default, never the name the
//     initiator asked for, so a listener cannot pass through what it does not
//     own.
//   * Conflicts are settled by install recency, and — contrary to the
//     documented "last extension installed whose listener passes a suggestion
//     object wins" — a later-installed extension answering "no opinion" beats
//     an earlier-installed one answering with a name.

import test from 'node:test';
import assert from 'node:assert';

import { attach, waitForTarget, sleep } from './chrome.js';
import { browserFactory, instrumented, neighbour, relative, withServer } from './fixture.js';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const withBrowser = browserFactory(9500);

test('a capture keeps its templated name with a rival downloads extension installed', async () => {
  // Mirrors the profile this was found on: a downloads extension installed
  // first, this one second. The rival bare-suggests anything it did not
  // start, which is what broke naming in the first place.
  const rival = neighbour('rival');
  const jsi = instrumented('jsi-naming');

  await withServer(8793, async (origin) => {
    await withBrowser([rival, jsi], async (browser) => {
      const rivalWorker = await attach(browser, (await waitForTarget(browser, browser.ids[0])).id);
      await rivalWorker.evaluate(`
        chrome.downloads.onDeterminingFilename.addListener((item, suggest) => { suggest(); });
        return true;`);

      const worker = await attach(browser, (await waitForTarget(browser, browser.ids[1])).id);
      const page = (await browser.targets()).find((t) => t.type === 'page');
      const { sessionId } = await browser.conn.send('Target.attachToTarget', {
        targetId: page.id,
        flatten: true,
      });
      await browser.conn.send('Page.navigate', { url: `${origin}/sticky.html` }, sessionId);
      await sleep(2500);

      await worker.evaluate(`
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await globalThis.__test_startRun(tab);
        return true;`);

      let record = null;
      for (let i = 0; i < 60 && !record; i += 1) {
        await sleep(1000);
        ({ lastCapture: record } = await worker.evaluate(
          `return await chrome.storage.local.get('lastCapture');`,
        ));
      }

      assert.ok(record, 'the capture never produced a download');
      assert.strictEqual(record.state, 'complete');
      assert.match(record.requested, /^screenshots\/127\.0\.0\.1\/.+\.png$/);
      assert.ok(
        record.saved.endsWith(record.requested),
        `asked for "${record.requested}", Chrome saved "${record.saved}"`,
      );
    });
  });
});

test('an idle capture extension leaves a neighbour’s filenames alone', async () => {
  // The listener is the destructive part, so it must not be registered when no
  // capture is running. This neighbour has no listener of its own: its name
  // survives only if nothing else is listening.
  const nb = neighbour('bystander');
  const jsi = instrumented('jsi-idle');

  await withBrowser([nb, jsi], async (browser) => {
    await waitForTarget(browser, browser.ids[1]);
    const bystander = await attach(browser, (await waitForTarget(browser, browser.ids[0])).id);

    const saved = await bystander.evaluate(`
      const id = await chrome.downloads.download({
        url: ${JSON.stringify(PNG)}, filename: 'bystander/kept.png', saveAs: false });
      await new Promise(r => setTimeout(r, 1200));
      const [item] = await chrome.downloads.search({ id });
      return item && item.filename;`);

    assert.strictEqual(
      relative(browser, saved),
      'bystander/kept.png',
      'a neighbour lost its filename while this extension was idle',
    );
  });
});

test('a registered listener is what destroys the filename', async () => {
  // The finding the three failed fixes all missed, pinned as a test so it
  // cannot quietly stop being true.
  const solo = neighbour('solo');

  await withBrowser([solo], async (browser) => {
    const w = await attach(browser, (await waitForTarget(browser, browser.ids[0])).id);

    const noListener = await w.evaluate(`
      const id = await chrome.downloads.download({
        url: ${JSON.stringify(PNG)}, filename: 'a/b/kept.png', saveAs: false });
      await new Promise(r => setTimeout(r, 1000));
      const [item] = await chrome.downloads.search({ id });
      return item && item.filename;`);
    assert.strictEqual(relative(browser, noListener), 'a/b/kept.png', 'baseline: no listener anywhere');

    const withDecliner = await w.evaluate(`
      globalThis.__fn = (item, suggest) => { suggest(); };
      chrome.downloads.onDeterminingFilename.addListener(globalThis.__fn);
      const id = await chrome.downloads.download({
        url: ${JSON.stringify(PNG)}, filename: 'a/b/lost.png', saveAs: false });
      await new Promise(r => setTimeout(r, 1000));
      const [item] = await chrome.downloads.search({ id });
      chrome.downloads.onDeterminingFilename.removeListener(globalThis.__fn);
      return item && item.filename;`);
    assert.notStrictEqual(
      relative(browser, withDecliner),
      'a/b/lost.png',
      'a bare suggest() no longer discards the requested filename — the workaround may be removable',
    );
  });
});
