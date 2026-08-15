import test from 'node:test';
import assert from 'node:assert';

import { buildCapturePlan, framePlacement, coverageGaps } from '../src/plan.js';

const base = { viewportWidth: 1280, viewportHeight: 800, dpr: 1 };

test('page shorter than the viewport plans a single frame', () => {
  const p = buildCapturePlan({ ...base, pageHeight: 400 });
  assert.deepStrictEqual(p.frames, [{ index: 0, scrollY: 0 }]);
  assert.strictEqual(p.canvasHeight, 400);
  assert.strictEqual(p.canvasWidth, 1280);
  assert.strictEqual(p.downscaled, false);
});

test('page exactly one viewport tall plans a single frame', () => {
  const p = buildCapturePlan({ ...base, pageHeight: 800 });
  assert.deepStrictEqual(p.frames, [{ index: 0, scrollY: 0 }]);
  assert.strictEqual(p.canvasHeight, 800);
});

test('exact multiple of the viewport has no overlapping final frame', () => {
  const p = buildCapturePlan({ ...base, pageHeight: 2400 });
  assert.deepStrictEqual(
    p.frames.map((f) => f.scrollY),
    [0, 800, 1600],
  );
});

test('non-multiple clamps the final frame to the bottom of the document', () => {
  const p = buildCapturePlan({ ...base, pageHeight: 2000 });
  assert.deepStrictEqual(
    p.frames.map((f) => f.scrollY),
    [0, 800, 1200],
  );
  assert.strictEqual(p.canvasHeight, 2000);
});

test('dpr 2 scales the canvas but not the frame list', () => {
  const p = buildCapturePlan({ ...base, dpr: 2, pageHeight: 2000 });
  assert.deepStrictEqual(
    p.frames.map((f) => f.scrollY),
    [0, 800, 1200],
  );
  assert.strictEqual(p.canvasWidth, 2560);
  assert.strictEqual(p.canvasHeight, 4000);
  assert.strictEqual(p.effectiveDpr, 2);
});

test('pixel budget forces a downscale and reports it', () => {
  // 1280 x 40000 CSS px at dpr 2 = 2560 x 80000 = 204.8M device px.
  const p = buildCapturePlan({ ...base, dpr: 2, pageHeight: 40000, pixelBudget: 40e6 });
  assert.ok(p.scale < 1, 'expected a downscale');
  assert.strictEqual(p.downscaled, true);
  assert.ok(
    p.canvasWidth * p.canvasHeight <= 40e6 * 1.001,
    `canvas ${p.canvasWidth}x${p.canvasHeight} exceeds the budget`,
  );
});

test('a generous budget still respects maxDim', () => {
  const p = buildCapturePlan({
    ...base,
    pageHeight: 200000,
    pixelBudget: 1e12,
    maxDim: 32767,
  });
  assert.ok(p.canvasHeight <= 32767, `canvasHeight ${p.canvasHeight}`);
  assert.ok(p.canvasWidth <= 32767, `canvasWidth ${p.canvasWidth}`);
  assert.strictEqual(p.downscaled, true);
});

test('absurd page heights refuse rather than planning forever', () => {
  assert.throws(
    () => buildCapturePlan({ ...base, pageHeight: 1e7, maxFrames: 500 }),
    /more than 500 captures/,
  );
});

test('maxFrames counts the clamped final frame too', () => {
  // maxScroll 399201 / 800 gives exactly 500 stepped frames, then the clamped
  // final frame makes 501. The in-loop guard alone never sees it.
  assert.throws(
    () => buildCapturePlan({ ...base, pageHeight: 400001, maxFrames: 500 }),
    /more than 500 captures/,
  );
  const ok = buildCapturePlan({ ...base, pageHeight: 400000, maxFrames: 500 });
  assert.strictEqual(ok.frames.length, 500);
});

test('the plan reports the page height its canvas was sized for', () => {
  const p = buildCapturePlan({ ...base, pageHeight: 1999.4 });
  assert.strictEqual(p.pageHeight, 2000);
  assert.strictEqual(p.canvasHeight, 2000);
});

test('degenerate input yields no NaN and a finite frame list', () => {
  const p = buildCapturePlan({
    pageHeight: NaN,
    viewportWidth: 0,
    viewportHeight: -5,
    dpr: 0,
  });
  assert.ok(Number.isFinite(p.canvasWidth) && p.canvasWidth >= 1);
  assert.ok(Number.isFinite(p.canvasHeight) && p.canvasHeight >= 1);
  assert.strictEqual(p.frames.length, 1);
  assert.ok(p.frames.every((f) => Number.isFinite(f.scrollY)));
});

const frame = {
  cssToBitmap: 1,
  frameWidthPx: 1280,
  frameHeightPx: 800,
  canvasWidth: 1280,
  canvasHeight: 2000,
  crop: { x: 0, y: 0, width: 1280, height: 800 },
};

test('framePlacement draws a mid-document frame at its actual scroll offset', () => {
  const pl = framePlacement({ ...frame, actualScrollY: 800 });
  assert.strictEqual(pl.skip, false);
  assert.deepStrictEqual(
    { sx: pl.sx, sy: pl.sy, sw: pl.sw, sh: pl.sh },
    { sx: 0, sy: 0, sw: 1280, sh: 800 },
  );
  assert.deepStrictEqual(
    { dx: pl.dx, dy: pl.dy, dw: pl.dw, dh: pl.dh },
    { dx: 0, dy: 800, dw: 1280, dh: 800 },
  );
  assert.deepStrictEqual(pl.covered, { start: 800, end: 1600 });
});

test('framePlacement trims rows an earlier frame already painted', () => {
  // The clamped final frame of a 2000px page: it sits at 1200 but frame 1
  // already owns everything above 1600. Repainting 1200-1600 would blank out a
  // sticky rail that frame 1 drew there, so the source is trimmed instead.
  const pl = framePlacement({ ...frame, actualScrollY: 1200, coveredTo: 1600 });
  assert.strictEqual(pl.skip, false);
  assert.strictEqual(pl.sy, 400);
  assert.strictEqual(pl.sh, 400);
  assert.strictEqual(pl.dy, 1600);
  assert.strictEqual(pl.dh, 400);
  assert.deepStrictEqual(pl.covered, { start: 1600, end: 2000 });
});

test('framePlacement trims nothing when the frame starts past what is covered', () => {
  const trimmed = framePlacement({ ...frame, actualScrollY: 800, coveredTo: 800 });
  const plain = framePlacement({ ...frame, actualScrollY: 800 });
  assert.deepStrictEqual(trimmed, plain);
});

test('framePlacement skips a frame wholly inside what is already covered', () => {
  const pl = framePlacement({ ...frame, actualScrollY: 800, coveredTo: 1600 });
  assert.strictEqual(pl.skip, true);
  assert.deepStrictEqual(pl.covered, { start: 1600, end: 1600 });
});

test('framePlacement clips the final frame at the canvas bottom', () => {
  // Canvas is 2000 tall; the last frame sits at 1200 and would run to 2000.
  const pl = framePlacement({ ...frame, actualScrollY: 1200 });
  assert.strictEqual(pl.dy, 1200);
  assert.strictEqual(pl.dh, 800);

  // Now a page 1900 tall: the frame at 1200 must be trimmed to 700 rows.
  const clipped = framePlacement({ ...frame, canvasHeight: 1900, actualScrollY: 1200 });
  assert.strictEqual(clipped.dy, 1200);
  assert.strictEqual(clipped.dh, 700);
  assert.strictEqual(clipped.sh, 700, 'source must be trimmed, not squashed');
  assert.deepStrictEqual(clipped.covered, { start: 1200, end: 1900 });
});

test('framePlacement skips a frame that lands entirely below the canvas', () => {
  const pl = framePlacement({ ...frame, canvasHeight: 500, actualScrollY: 800 });
  assert.strictEqual(pl.skip, true);
  assert.strictEqual(pl.dh, 0);
  assert.deepStrictEqual(pl.covered, { start: 800, end: 800 });
});

test('framePlacement handles retina frames without stretching', () => {
  const pl = framePlacement({
    actualScrollY: 800,
    cssToBitmap: 2,
    frameWidthPx: 2560,
    frameHeightPx: 1600,
    canvasWidth: 2560,
    canvasHeight: 4000,
    crop: { x: 0, y: 0, width: 1280, height: 800 },
  });
  assert.deepStrictEqual(
    { sx: pl.sx, sy: pl.sy, sw: pl.sw, sh: pl.sh },
    { sx: 0, sy: 0, sw: 2560, sh: 1600 },
  );
  assert.strictEqual(pl.dy, 1600);
  assert.strictEqual(pl.dh, 1600);
});

test('framePlacement downscales source to canvas when scale < 1', () => {
  // dpr 2 frames stitched onto a dpr 1 canvas.
  const pl = framePlacement({
    actualScrollY: 800,
    cssToBitmap: 2,
    frameWidthPx: 2560,
    frameHeightPx: 1600,
    canvasWidth: 1280,
    canvasHeight: 2000,
    crop: { x: 0, y: 0, width: 1280, height: 800 },
  });
  assert.strictEqual(pl.sw, 2560);
  assert.strictEqual(pl.sh, 1600);
  assert.strictEqual(pl.dw, 1280);
  assert.strictEqual(pl.dh, 800);
});

test('framePlacement honours a crop rect for an inner scroller', () => {
  const pl = framePlacement({
    actualScrollY: 300,
    cssToBitmap: 1,
    frameWidthPx: 1280,
    frameHeightPx: 800,
    canvasWidth: 1080,
    canvasHeight: 1500,
    crop: { x: 200, y: 60, width: 1080, height: 740 },
  });
  assert.deepStrictEqual(
    { sx: pl.sx, sy: pl.sy, sw: pl.sw, sh: pl.sh },
    { sx: 200, sy: 60, sw: 1080, sh: 740 },
  );
  assert.strictEqual(pl.dy, 300);
  assert.strictEqual(pl.dh, 740);
});

test('limitTo stops a gap retry at the end of the gap', () => {
  // Snap left rows 800..1000 unpainted; 1000..1600 is already correct. The
  // retry is scrolled to 800 but still returns a whole viewport, so without a
  // limit it repaints 800 good rows over 600 good ones.
  const pl = framePlacement({ ...frame, actualScrollY: 800, coveredTo: 800, limitTo: 1000 });
  assert.strictEqual(pl.skip, false);
  assert.deepStrictEqual({ sy: pl.sy, sh: pl.sh }, { sy: 0, sh: 200 });
  assert.deepStrictEqual({ dy: pl.dy, dh: pl.dh }, { dy: 800, dh: 200 });
  assert.deepStrictEqual(pl.covered, { start: 800, end: 1000 });
});

test('an explicit canvasScaleY fills the canvas to its last row', () => {
  // 61823 CSS px at dpr 1 under a 40M budget: the canvas is 528 x 32767, so
  // the true vertical scale is 32767/61823. Deriving it from the rounded
  // canvas width (528/997) instead leaves the bottom 26 rows unpainted, and
  // coverageGaps cannot see it because it converts back through the same
  // wrong number.
  const crop = { x: 0, y: 0, width: 997, height: 617 };
  const p = buildCapturePlan({
    pageHeight: 61823, viewportWidth: 997, viewportHeight: 617, dpr: 1, pixelBudget: 40e6,
  });
  assert.strictEqual(p.canvasWidth, 528);
  assert.strictEqual(p.canvasHeight, 32767);

  const canvasScaleY = p.canvasHeight / p.pageHeight;
  const covered = [];
  let coveredTo = 0;
  let last;
  for (const f of p.frames) {
    const pl = framePlacement({
      actualScrollY: f.scrollY,
      cssToBitmap: 1,
      frameWidthPx: 997,
      frameHeightPx: 617,
      canvasWidth: p.canvasWidth,
      canvasHeight: p.canvasHeight,
      crop,
      coveredTo,
      canvasScaleY,
    });
    if (pl.skip) continue;
    // Rows are handed out in order and never twice.
    assert.strictEqual(pl.dy, last ? last.dy + last.dh : 0, `frame ${f.index} does not abut`);
    // Source trimming belongs to the bottom of the canvas, nowhere else.
    if (f.index > 0 && f.scrollY + crop.height <= p.pageHeight) {
      assert.strictEqual(pl.sh, Math.round(pl.covered.end - pl.covered.start));
    }
    covered.push(pl.covered);
    coveredTo = Math.max(coveredTo, pl.covered.end);
    last = pl;
  }
  assert.strictEqual(last.dy + last.dh, p.canvasHeight, 'canvas has unpainted rows at the bottom');
  assert.deepStrictEqual(coverageGaps(covered, 61823), []);
});

test('every canvas row is painted exactly once at dpr 2 with a crop offset', () => {
  const crop = { x: 0, y: 71, width: 1440, height: 829 };
  const p = buildCapturePlan({
    pageHeight: 7411, viewportWidth: 1440, viewportHeight: 829, dpr: 2, pixelBudget: 40e6,
  });
  const canvasScaleY = p.canvasHeight / p.pageHeight;
  const covered = [];
  let coveredTo = 0;
  let cursor = 0;
  for (const f of p.frames) {
    const pl = framePlacement({
      actualScrollY: f.scrollY,
      cssToBitmap: 2,
      frameWidthPx: 2880,
      frameHeightPx: 1800,
      canvasWidth: p.canvasWidth,
      canvasHeight: p.canvasHeight,
      crop,
      coveredTo,
      canvasScaleY,
    });
    if (pl.skip) continue;
    assert.strictEqual(pl.dy, cursor, `frame ${f.index} leaves a seam`);
    // Source must start below the crop's own top inset, never at 0.
    assert.ok(pl.sy >= Math.round(crop.y * 2), `frame ${f.index} reads above the crop`);
    cursor = pl.dy + pl.dh;
    covered.push(pl.covered);
    coveredTo = Math.max(coveredTo, pl.covered.end);
  }
  assert.strictEqual(cursor, p.canvasHeight);
  assert.deepStrictEqual(coverageGaps(covered, 7411), []);
});

test('coverageGaps returns empty for full coverage', () => {
  assert.deepStrictEqual(
    coverageGaps([{ start: 0, end: 800 }, { start: 800, end: 1600 }, { start: 1200, end: 2000 }], 2000),
    [],
  );
});

test('coverageGaps finds a scroll-snap hole', () => {
  // Asked for 800, snap landed at 1000: rows 800..1000 were never captured.
  const gaps = coverageGaps([{ start: 0, end: 800 }, { start: 1000, end: 1800 }], 1800);
  assert.deepStrictEqual(gaps, [{ start: 800, end: 1000 }]);
});

test('coverageGaps reports an unreached tail', () => {
  assert.deepStrictEqual(coverageGaps([{ start: 0, end: 800 }], 2000), [
    { start: 800, end: 2000 },
  ]);
});

test('coverageGaps tolerates sub-pixel seams', () => {
  assert.deepStrictEqual(
    coverageGaps([{ start: 0, end: 799.6 }, { start: 800, end: 1600 }], 1600),
    [],
  );
});

test('coverageGaps ignores empty and out-of-range intervals', () => {
  assert.deepStrictEqual(
    coverageGaps(
      [null, { start: 5, end: 5 }, { start: -100, end: 900 }, { start: 900, end: 99999 }],
      1000,
    ),
    [],
  );
});
