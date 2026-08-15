// Pure capture math. No `chrome`, no DOM, no I/O — this is the tested core.
//
// Coordinate systems in play:
//   CSS px     — what the page reports (scrollY, scrollHeight, clientWidth)
//   bitmap px  — what captureVisibleTab hands back (CSS px * devicePixelRatio)
//   canvas px  — the stitched output (CSS px * effectiveDpr, where
//                effectiveDpr = devicePixelRatio * scale)
//
// `scale` is <= 1 and exists only to keep the canvas inside an operational
// memory budget. It is reported so a downscaled result is never mistaken for
// a full-resolution one.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * @param {object} o
 * @param {number} o.pageHeight       scrollable content height, CSS px
 * @param {number} o.viewportWidth    width of the region being captured, CSS px
 * @param {number} o.viewportHeight   height of the region being captured, CSS px
 * @param {number} o.dpr              devicePixelRatio of the target page
 * @param {number} [o.pixelBudget]    operational cap on canvas area, device px
 * @param {number} [o.maxDim]         per-dimension cap, device px
 * @param {number} [o.maxFrames]      refuse to plan more than this many captures
 * @returns {{scale:number, effectiveDpr:number, canvasWidth:number,
 *            canvasHeight:number, pageHeight:number,
 *            frames:Array<{index:number,scrollY:number}>, downscaled:boolean}}
 */
export function buildCapturePlan({
  pageHeight,
  viewportWidth,
  viewportHeight,
  dpr,
  pixelBudget = 40e6,
  maxDim = 32767,
  maxFrames = 500,
}) {
  const vw = Math.max(1, Math.floor(finite(viewportWidth, 1)));
  const vh = Math.max(1, Math.floor(finite(viewportHeight, 1)));
  const ph = Math.max(1, Math.ceil(finite(pageHeight, vh)));
  const d = finite(dpr, 1) > 0 ? finite(dpr, 1) : 1;

  const rawW = vw * d;
  const rawH = ph * d;

  let scale = 1;
  const area = rawW * rawH;
  if (pixelBudget > 0 && area > pixelBudget) scale = Math.sqrt(pixelBudget / area);
  if (maxDim > 0) {
    if (rawW * scale > maxDim) scale = Math.min(scale, maxDim / rawW);
    if (rawH * scale > maxDim) scale = Math.min(scale, maxDim / rawH);
  }
  scale = clamp(scale, 1e-4, 1);

  const effectiveDpr = d * scale;
  const canvasWidth = Math.max(1, Math.round(vw * effectiveDpr));
  const canvasHeight = Math.max(1, Math.round(ph * effectiveDpr));

  // Frames step by one viewport; the final frame is clamped to the bottom of
  // the document and therefore overlaps its predecessor. That overlap is NOT
  // harmless: pinned elements are hidden per-frame, so a later frame would
  // repaint blank over a sticky rail an earlier frame drew correctly. The
  // caller passes `coveredTo` to `framePlacement` so earlier rows win.
  const maxScroll = Math.max(0, ph - vh);
  const frames = [];
  for (let y = 0; y < maxScroll; y += vh) {
    frames.push({ index: frames.length, scrollY: y });
    if (frames.length > maxFrames) {
      throw new Error(`page needs more than ${maxFrames} captures (${ph}px tall)`);
    }
  }
  if (frames.length === 0 || frames[frames.length - 1].scrollY < maxScroll) {
    frames.push({ index: frames.length, scrollY: maxScroll });
  }
  // The clamped final frame is appended outside the loop, so the in-loop guard
  // alone lets `maxFrames + 1` through.
  if (frames.length > maxFrames) {
    throw new Error(`page needs more than ${maxFrames} captures (${ph}px tall)`);
  }

  return {
    scale,
    effectiveDpr,
    canvasWidth,
    canvasHeight,
    // The rounded-up height the canvas was actually sized for. `framePlacement`
    // needs it to derive an exact vertical scale.
    pageHeight: ph,
    frames,
    downscaled: scale < 1,
  };
}

/**
 * Where one decoded frame lands on the stitched canvas.
 *
 * `cssToBitmap` is derived by the caller from the decoded frame's actual width
 * divided by the layout viewport width — not from devicePixelRatio, which lies
 * under browser zoom.
 *
 * `crop` is the region of the viewport being captured, in CSS px relative to
 * the viewport's top-left. For a root-scroller capture it is the whole
 * viewport; for a viewport-filling inner scroller it is that element's content
 * box.
 *
 * `coveredTo` is the document offset (CSS px) that earlier frames already
 * painted. Rows above it are trimmed off the top of this frame's source so a
 * later frame cannot overwrite them — which matters because a pinned element
 * is drawn only in its home frame and hidden everywhere else, so an
 * overlapping later frame would repaint that band blank.
 *
 * `limitTo` is the document offset this frame must not paint past. It exists
 * for gap retries: a retry is scrolled to the top of the gap but still returns
 * a whole viewport, and painting all of it would overwrite good pixels below
 * the gap the same way an unbounded overlap overwrites good pixels above it.
 *
 * `canvasScaleY` is canvas px per document CSS px, vertically. Pass it. The
 * fallback, `canvasWidth / crop.width`, is the *horizontal* scale, and
 * `canvasWidth` is rounded — on a tall downscaled page the two scales differ
 * by enough to leave unpainted rows at the bottom of the canvas that
 * `coverageGaps` cannot see, because it converts coverage back through the
 * same wrong number.
 *
 * @returns {{sx:number, sy:number, sw:number, sh:number,
 *            dx:number, dy:number, dw:number, dh:number,
 *            skip:boolean, covered:{start:number,end:number}}}
 */
export function framePlacement({
  actualScrollY,
  cssToBitmap,
  frameWidthPx,
  frameHeightPx,
  canvasWidth,
  canvasHeight,
  crop,
  coveredTo = 0,
  limitTo = Infinity,
  canvasScaleY,
}) {
  const r = finite(cssToBitmap, 1) > 0 ? finite(cssToBitmap, 1) : 1;
  const fw = Math.max(0, Math.floor(finite(frameWidthPx, 0)));
  const fh = Math.max(0, Math.floor(finite(frameHeightPx, 0)));
  const c = crop && crop.width > 0 && crop.height > 0
    ? crop
    : { x: 0, y: 0, width: fw / r, height: fh / r };
  const y = Math.max(0, finite(actualScrollY, 0));

  const fallbackScale = canvasWidth / c.width;
  const yScaleRaw = finite(canvasScaleY, fallbackScale);
  const yScale = yScaleRaw > 0 ? yScaleRaw : 1;

  // Every edge is decided in document CSS px first, then rounded exactly once
  // on the way into canvas px and once on the way into bitmap px. Rounding an
  // origin and a length separately is what puts one-pixel seams between frames
  // and makes ordinary mid-page frames look like they need bottom clipping.
  const bottomCss = canvasHeight / yScale;
  const startCss = clamp(Math.max(y, finite(coveredTo, 0)), y, y + c.height);
  const endCss = clamp(
    Math.min(y + c.height, bottomCss, finite(limitTo, Infinity)),
    startCss,
    y + c.height,
  );

  const dy = clamp(Math.round(startCss * yScale), 0, canvasHeight);
  const dh = clamp(Math.round(endCss * yScale), 0, canvasHeight) - dy;

  const sx = clamp(Math.round(c.x * r), 0, fw);
  const sw = clamp(Math.round((c.x + c.width) * r), 0, fw) - sx;
  const sy = clamp(Math.round((c.y + (startCss - y)) * r), 0, fh);
  const sh = clamp(Math.round((c.y + (endCss - y)) * r), 0, fh) - sy;

  if (dh <= 0 || sw <= 0 || sh <= 0) {
    return {
      sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: 0, dh: 0,
      skip: true,
      covered: { start: startCss, end: startCss },
    };
  }

  return {
    sx, sy, sw, sh,
    dx: 0,
    dy,
    dw: canvasWidth,
    dh,
    skip: false,
    covered: { start: startCss, end: endCss },
  };
}

/**
 * Vertical stretches of the document that no frame covered. An empty array
 * means the page is fully accounted for.
 *
 * @param {Array<{start:number,end:number}>} intervals  CSS px
 * @param {number} pageHeight  CSS px
 * @param {number} [tolerance] sub-pixel slack, CSS px
 */
export function coverageGaps(intervals, pageHeight, tolerance = 1) {
  const total = Math.max(0, finite(pageHeight, 0));
  const list = (intervals || [])
    .filter((i) => i && Number.isFinite(i.start) && Number.isFinite(i.end))
    .map((i) => ({ start: Math.max(0, i.start), end: Math.min(total, i.end) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);

  const gaps = [];
  let cursor = 0;
  for (const iv of list) {
    if (iv.start > cursor + tolerance) gaps.push({ start: cursor, end: iv.start });
    if (iv.end > cursor) cursor = iv.end;
    if (cursor >= total) break;
  }
  if (cursor < total - tolerance) gaps.push({ start: cursor, end: total });
  return gaps;
}

function finite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
