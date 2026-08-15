// Load the built ZIP the way the Web Store will unpack it, and take one real
// capture with it.
//
// The package is a different artefact from the source tree — a missing file or
// a path the manifest names but the copy step skipped shows up here and nowhere
// else. Run after `npm run package`.

import { mkdtempSync, rmSync, readdirSync, existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { attach, waitForTarget, sleep } from '../tests/e2e/chrome.js';
import { browserFactory, withServer } from '../tests/e2e/fixture.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const zips = existsSync(join(ROOT, 'dist'))
  ? readdirSync(join(ROOT, 'dist')).filter((f) => f.endsWith('.zip'))
  : [];
if (zips.length !== 1) {
  console.error(`expected exactly one zip in dist/, found ${zips.length}. Run: npm run package`);
  process.exit(1);
}
const zip = join(ROOT, 'dist', zips[0]);

const work = mkdtempSync(join(tmpdir(), 'jsi-pkg-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const unpacked = join(work, 'unpacked');
execFileSync('unzip', ['-q', zip, '-d', unpacked]);

// The same two rig-only deltas the e2e suite uses: CDP cannot click a toolbar
// button, and `activeTab` is only granted by a real click. Applied to the
// unpacked copy so what is exercised is otherwise byte-identical to the upload.
appendFileSync(join(unpacked, 'src/background.js'), '\nglobalThis.__test_startRun = startRun;\n');
const mf = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
writeFileSync(join(unpacked, 'manifest.json'), JSON.stringify(mf, null, 2));

const withBrowser = browserFactory(9900);

await withServer(8799, async (origin) => {
  await withBrowser([unpacked], async (browser) => {
    const worker = await attach(browser, (await waitForTarget(browser, browser.ids[0])).id);
    const page = (await browser.targets()).find((t) => t.type === 'page');
    const { sessionId } = await browser.conn.send('Target.attachToTarget', {
      targetId: page.id,
      flatten: true,
    });
    await browser.conn.send('Page.navigate', { url: `${origin}/demo.html` }, sessionId);
    await sleep(2500);

    await worker.evaluate(`
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
      throw new Error(`the packaged extension did not complete a capture: ${JSON.stringify(record)}`);
    }
    if (!record.saved.endsWith(record.requested)) {
      throw new Error(`asked for "${record.requested}", got "${record.saved}"`);
    }
    if (worker.logs.some((l) => /error|Unchecked/i.test(l))) {
      throw new Error(`the worker logged errors:\n  ${worker.logs.join('\n  ')}`);
    }
    console.log(`${zips[0]} loads, captures, and saves as ${record.requested}`);
  });
});
