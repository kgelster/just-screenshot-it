import test from 'node:test';
import assert from 'node:assert';

import {
  clampSetting,
  isDegenerateTemplate,
  mpToPixels,
  normalizeDestinations,
  pixelsToMp,
  splitPreview,
} from '../src/settings-util.js';
import { BOUNDS, DEFAULTS } from '../src/defaults.js';

// ------------------------------------------------------------- unit display

test('the budget round-trips between megapixels and pixels', () => {
  assert.strictEqual(pixelsToMp(DEFAULTS.pixelBudget), 40);
  assert.strictEqual(mpToPixels(40), DEFAULTS.pixelBudget);
  assert.strictEqual(mpToPixels(pixelsToMp(DEFAULTS.pixelBudget)), DEFAULTS.pixelBudget);
});

test('a fractional megapixel entry becomes a whole pixel count', () => {
  assert.strictEqual(mpToPixels(2.5), 2500000);
  assert.strictEqual(mpToPixels('7.25'), 7250000);
});

// ------------------------------------------------------------------ clamping

test('unusable input is null, so the caller can keep the old value', () => {
  // The old collect() substituted DEFAULTS[key] here, which silently threw
  // away a custom setting whenever a field was momentarily empty.
  for (const raw of ['', '   ', 'abc', null, undefined, NaN, Infinity]) {
    assert.strictEqual(clampSetting('settleMs', raw), null, `for ${String(raw)}`);
  }
});

test('out of range clamps rather than reverting', () => {
  assert.strictEqual(clampSetting('jpegQuality', 400), 100);
  assert.strictEqual(clampSetting('jpegQuality', 1), 10);
  assert.strictEqual(clampSetting('captureIntervalMs', 100), 500);
  assert.strictEqual(clampSetting('pixelBudget', 9e9), 2e8);
});

test('zero is a legal settle delay and is not treated as missing', () => {
  assert.strictEqual(clampSetting('settleMs', 0), 0);
  assert.strictEqual(clampSetting('settleMs', '0'), 0);
});

test('an unbounded key never yields a value', () => {
  assert.strictEqual(clampSetting('filenameTemplate', 'anything'), null);
});

test('every default sits inside its own bounds', () => {
  for (const [key, bounds] of Object.entries(BOUNDS)) {
    const value = DEFAULTS[key];
    assert.ok(
      value >= bounds.min && value <= bounds.max,
      `${key} default ${value} is outside ${bounds.min}..${bounds.max}`,
    );
  }
});

// -------------------------------------------------------------- destinations

test('a run with no destination is given one', () => {
  assert.deepStrictEqual(
    normalizeDestinations({ download: false, copyToClipboard: false }),
    { download: true, copyToClipboard: false },
  );
});

test('a run with either destination is left exactly as it is', () => {
  const clipboardOnly = { download: false, copyToClipboard: true, format: 'png' };
  assert.strictEqual(normalizeDestinations(clipboardOnly), clipboardOnly);

  const downloadOnly = { download: true, copyToClipboard: false };
  assert.strictEqual(normalizeDestinations(downloadOnly), downloadOnly);
});

// ------------------------------------------------------------------ preview

test('the preview splits a built path into folders, stem and extension', () => {
  assert.deepStrictEqual(splitPreview('fullpage-shot/example.com/2026-08-14-shot.png'), {
    dirs: ['fullpage-shot', 'example.com'],
    stem: '2026-08-14-shot',
    ext: 'png',
  });
});

test('the preview splits a bare filename with no folders', () => {
  assert.deepStrictEqual(splitPreview('capture.png'), {
    dirs: [],
    stem: 'capture',
    ext: 'png',
  });
});

test('a stem containing dots keeps them; only the last one is the extension', () => {
  assert.deepStrictEqual(splitPreview('site/v1.2.3-page.jpg'), {
    dirs: ['site'],
    stem: 'v1.2.3-page',
    ext: 'jpg',
  });
});

// ------------------------------------------------------------ degeneracy

test('a template with no tokens names every capture the same thing', () => {
  assert.strictEqual(isDegenerateTemplate(''), true);
  assert.strictEqual(isDegenerateTemplate('   '), true);
  assert.strictEqual(isDegenerateTemplate('screenshot.png'), true);
  // {ext} alone still resolves to one name for every page.
  assert.strictEqual(isDegenerateTemplate('screenshot.{ext}'), true);
});

test('any distinguishing token clears the warning', () => {
  assert.strictEqual(isDegenerateTemplate(DEFAULTS.filenameTemplate), false);
  assert.strictEqual(isDegenerateTemplate('{host}.{ext}'), false);
  assert.strictEqual(isDegenerateTemplate('{ss}'), false);
});
