// The run loop lives here.
//
// An offscreen document is a persistent page with a DOM, and its messages
// reset the service worker's idle timer — so it can drive a multi-second
// capture that a service worker cannot. It pays for that by being allowed to
// call `chrome.runtime` and nothing else: every captureVisibleTab, every
// tabs.sendMessage, every downloads.download goes back through the worker.

import { buildCapturePlan, framePlacement, coverageGaps } from './plan.js';

const REVOKE_FALLBACK_MS = 60000;

// Nothing in the clipboard step may outlive the capture. See `copyImage` for
// why that needs saying: one unsettleable promise in there is what wedged the
// extension until Chrome was restarted.
const CLIPBOARD_TIMEOUT_MS = 15000;

// Only the HTML flavour reaches the system clipboard, and it carries the image
// inline as base64, so a capture has to be small enough to be worth inlining.
const MAX_CLIPBOARD_BYTES = 24 * 1024 * 1024;

/** The run this document is currently loyal to; null when idle. */
let activeToken = null;

// ------------------------------------------------------------------- RPC

async function bg(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ target: 'background', type, ...payload });
  if (res && res.error) throw new Error(res.error);
  return res ? res.value : undefined;
}

const page = (token, method, args = {}) => bg('page', { token, method, args });

/**
 * Name the current stage for the toolbar button's tooltip.
 *
 * Deliberately not awaited: this is commentary, and a capture must not stall
 * or fail because a status line did not get through.
 */
const phase = (token, label) => {
  bg('phase', { token, label }).catch(() => {});
};

// --------------------------------------------------------------- decoding

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma);
  const base64 = meta.endsWith(';base64');
  const type = base64 ? meta.slice(0, -7) : meta || 'image/png';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

const decodeFrame = (dataUrl) => createImageBitmap(dataUrlToBlob(dataUrl));

// ---------------------------------------------------------------- canvas

/**
 * Allocate the stitching canvas, halving the pixel budget on failure.
 * Chromium's documented per-dimension cap is not the real limit — a canvas of
 * 268M pixels needs ~1 GiB of backing store before a single frame is decoded,
 * and allocation fails silently well below any published ceiling. So probe.
 */
function allocate(planInput) {
  let budget = planInput.pixelBudget;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const plan = buildCapturePlan({ ...planInput, pixelBudget: budget });
    try {
      const canvas = new OffscreenCanvas(plan.canvasWidth, plan.canvasHeight);
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('no 2d context');
      // Write a known colour to the far corner and read it back. With
      // `alpha: false` the alpha channel is always 255, so checking alpha
      // would pass even on a canvas that was never allocated.
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(plan.canvasWidth - 1, plan.canvasHeight - 1, 1, 1);
      const p = ctx.getImageData(plan.canvasWidth - 1, plan.canvasHeight - 1, 1, 1).data;
      if (p[0] !== 255 || p[1] !== 0 || p[2] !== 255) {
        throw new Error('canvas backing store is not writable');
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight);
      return { canvas, ctx, plan };
    } catch (e) {
      lastError = e;
      budget = Math.floor(budget / 2);
    }
  }
  throw new Error(
    `could not allocate a canvas for this page (${(lastError && lastError.message) || 'unknown'})`,
  );
}

// -------------------------------------------------------------- clipboard

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('could not read the stitched image'));
    reader.readAsDataURL(blob);
  });

/** Wait for an <img> to be usable. Deliberately not `decode()` — see below. */
const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the stitched image would not load'));
    img.src = src;
  });

/**
 * Put the stitched image on the clipboard.
 *
 * Every constraint below was measured against a real offscreen document on
 * Chrome 151, headed and headless, and is pinned in
 * `tests/e2e/capture-lifecycle.test.js`.
 *
 * **An offscreen document is never rendered.** `requestAnimationFrame` never
 * fires in one, and `HTMLImageElement.decode()` never settles — not for a
 * 40 MP screenshot, not for a 1x1 PNG. This function used to `await
 * img.decode()`, which is why the extension captured exactly once per browser
 * session: the run loop stopped there forever, the flag that says "a capture is
 * in progress" never cleared, and every later attempt was refused with "the
 * previous one is still finishing" until Chrome restarted. The `load` event
 * does fire, so that is what we wait on.
 *
 * **`navigator.clipboard` is unusable here.** It checks document focus before
 * extension permission, and an offscreen document can never be focused
 * (crbug 41497480); it throws NotAllowedError, "Document is not focused".
 *
 * That leaves `execCommand('copy')` over a selected `<img>`, which does work
 * here. Two things about it are worth knowing. It was seen returning false over
 * a selection the document had never laid out, and while that has not been
 * reproducible since, an unrendered document lays out only when something reads
 * a layout property, so the `offsetWidth` read below stays as cheap insurance.
 * And the only flavour that reaches the system clipboard is HTML: there is no
 * PNG flavour, so rich-text targets (Slack, Gmail, Docs) get the picture and
 * pixel editors get nothing. Since HTML is all that lands, the `<img>` has to
 * carry a self-contained `data:` URL — a `blob:chrome-extension://…` src pastes
 * as a broken image everywhere outside this browser.
 */
async function copyImage(blob) {
  if (blob.size > MAX_CLIPBOARD_BYTES) {
    throw new Error(
      `${Math.round(blob.size / 1e6)} MB is too large to inline on the clipboard`,
    );
  }
  const holder = document.getElementById('clip');
  holder.innerHTML = '';
  const img = await loadImage(await blobToDataUrl(blob));
  holder.appendChild(img);
  void img.offsetWidth; // forces layout; execCommand returns false without it

  const range = document.createRange();
  range.selectNode(img);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  holder.focus();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    sel.removeAllRanges();
    holder.innerHTML = '';
  }
  return ok;
}

/**
 * Fail a step rather than let it hang.
 *
 * The run loop is a chain of awaits with no supervisor: any one of them that
 * never settles takes the whole capture with it, silently. Everything that
 * crosses into browser-owned machinery gets a ceiling.
 */
const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
    }),
  ]);

// ------------------------------------------------------------------- run

async function capture(token, options) {
  const format = options.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = Math.round(options.jpegQuality);
  const captureArgs = { intervalMs: options.captureIntervalMs, quality };

  let prepared = false;
  let blobUrl = null;

  try {
    // Everything before the first frame is silent otherwise. The pre-pass
    // scrolls the whole page to trigger lazy loading, which on a tall page is
    // the longest part of a capture, and the badge sits on "..." throughout —
    // a capture that is working reads as one that has hung.
    phase(token, options.prePass ? 'loading lazy content' : 'preparing the page');
    const prep = await page(token, 'prepare', {
      prePass: options.prePass,
      overlayPolicy: options.overlayPolicy,
    });
    prepared = true;
    if (prep && prep.mode === 'refuse') throw new Error(prep.reason);

    phase(token, 'measuring the page');
    const m = await page(token, 'measure');
    const planInput = {
      pageHeight: m.pageHeight,
      viewportWidth: m.crop.width,
      viewportHeight: m.crop.height,
      dpr: m.dpr,
      pixelBudget: options.pixelBudget,
    };
    const { canvas, ctx, plan } = allocate(planInput);

    const covered = [];
    const frameYs = plan.frames.map((f) => f.scrollY);
    // Canvas px per document CSS px. Derived from the plan's own numbers, not
    // from the rounded canvas width — see framePlacement's `canvasScaleY`.
    const canvasScaleY = plan.canvasHeight / plan.pageHeight;

    // A gap retry is scrolled to the top of the gap, which is usually not a
    // planned frame offset. The pinned-element policy is keyed to planned
    // offsets, so pass the planned frame that owns this band; otherwise every
    // pinned element counts as away from home and the retry paints its rail
    // blank.
    const owningFrame = (docY) => {
      let owner = frameYs[0] || 0;
      for (const fy of frameYs) if (fy <= docY) owner = fy;
      return owner;
    };

    const drawAt = async (targetY, index, total, coveredTo, limitTo = Infinity) => {
      const s = await page(token, 'scrollTo', { y: targetY, settleMs: options.settleMs });
      if (Math.abs(s.pageHeight - m.pageHeight) > 4) {
        throw new Error(
          `the page changed height mid-capture (${m.pageHeight} -> ${s.pageHeight}); ` +
            'nothing was saved rather than saving a torn image',
        );
      }
      await page(token, 'beforeFrame', {
        frameY: owningFrame(targetY),
        frames: frameYs,
        viewportHeight: m.crop.height,
      });

      // The oversized-frame guard lives in the worker: a data URL above the
      // messaging cap fails on the way here, so checking its length on this
      // side is a check that can never run.
      const dataUrl = await bg('capture', { token, format, ...captureArgs });

      const bmp = await decodeFrame(dataUrl);
      let placement;
      try {
        const cssToBitmap = bmp.width / m.viewportWidth;
        const pl = framePlacement({
          actualScrollY: s.actualScrollY,
          cssToBitmap,
          frameWidthPx: bmp.width,
          frameHeightPx: bmp.height,
          canvasWidth: plan.canvasWidth,
          canvasHeight: plan.canvasHeight,
          crop: m.crop,
          coveredTo,
          limitTo,
          canvasScaleY,
        });
        placement = pl;
        if (!pl.skip) {
          ctx.drawImage(bmp, pl.sx, pl.sy, pl.sw, pl.sh, pl.dx, pl.dy, pl.dw, pl.dh);
          covered.push(pl.covered);
        }
      } finally {
        bmp.close();
      }
      if (total) await bg('progress', { token, done: index, total });
      return placement;
    };

    // Sequential frames are first-writer-wins: the final frame is clamped to
    // the bottom of the document and overlaps its predecessor, and repainting
    // that overlap would blank out any pinned element the earlier frame owned.
    // Publish the frame count before the first frame lands, so the badge
    // switches from "..." to a counter as soon as the plan exists.
    await bg('progress', { token, done: 0, total: plan.frames.length });

    let coveredTo = 0;
    for (const f of plan.frames) {
      const pl = await drawAt(f.scrollY, f.index + 1, plan.frames.length, coveredTo);
      if (pl && !pl.skip) coveredTo = Math.max(coveredTo, pl.covered.end);
    }

    // Scroll snap, anchoring, and sticky relayout can all leave a hole where a
    // frame landed somewhere other than where it was sent. Go back for them.
    let warning = '';
    for (let round = 0; round < 2; round += 1) {
      const gaps = coverageGaps(covered, m.pageHeight);
      if (!gaps.length) break;
      console.warn('[fullpage-shot] coverage gaps, retrying', gaps);
      // A gap is by definition unpainted, so a retry starts exactly at it
      // rather than at the running high-water mark — and stops at the end of
      // the gap, because the retry still returns a whole viewport and the rows
      // below the gap are already correct.
      for (const gap of gaps) await drawAt(gap.start, 0, 0, gap.start, gap.end);
    }
    const remaining = coverageGaps(covered, m.pageHeight);
    if (remaining.length) {
      const px = remaining.reduce((a, g) => a + (g.end - g.start), 0);
      warning = `${Math.round(px)}px of the page could not be captured`;
      console.warn('[fullpage-shot]', warning, remaining);
    }

    await page(token, 'restore');
    prepared = false;

    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await canvas.convertToBlob(
      format === 'jpeg' ? { type: mime, quality: quality / 100 } : { type: mime },
    );
    if (!blob) throw new Error('encoding the stitched image failed');
    blobUrl = URL.createObjectURL(blob);

    // The blob URL goes to the downloader as-is. An earlier revision base64'd
    // the image into a data URL first, on the theory that `downloads.download()`
    // would not honour `filename` for a `blob:` URL. Measured on Chrome 151,
    // that theory was wrong in both directions: a blob URL is named correctly
    // when nothing interferes, and a data URL is named just as badly when
    // something does. The real cause was an `onDeterminingFilename` listener —
    // see `src/background.js`. So the conversion bought nothing, and cost a
    // full re-encode plus a third again in size against the 64 MiB messaging
    // cap, which is what put a ceiling on how tall a page could be saved.
    //
    // Download first: a clipboard failure must never cost the file.
    let info = null;
    if (options.download) {
      info = await bg('download', {
        token,
        url: blobUrl,
        ext: format === 'jpeg' ? 'jpg' : 'png',
        template: options.filenameTemplate,
        // From `measure()`, i.e. the page's own `location.href` and
        // `document.title`. The worker's copy comes off a tab object that
        // `activeTab` may have handed over with both fields blank.
        pageUrl: m.url,
        pageTitle: m.title,
        width: plan.canvasWidth,
        height: plan.canvasHeight,
      });
    }
    const downloaded = Boolean(info);

    // `activeToken` as well as the timeout: a run superseded between the
    // download and here would otherwise fight the live one over the single
    // `#clip` holder they share.
    let copied = false;
    if (options.copyToClipboard && activeToken === token) {
      try {
        copied = await withTimeout(copyImage(blob), CLIPBOARD_TIMEOUT_MS, 'the clipboard copy');
      } catch (e) {
        console.warn('[fullpage-shot] clipboard copy failed:', e);
      }
    }

    scheduleRevoke(blobUrl, downloaded ? REVOKE_FALLBACK_MS : 5000);
    blobUrl = null;

    await bg('done', {
      token,
      downloaded,
      copied,
      downscaled: plan.downscaled,
      scale: plan.scale,
      warning,
      filename: info && info.filename,
      frames: plan.frames.length,
      size: `${plan.canvasWidth}x${plan.canvasHeight}`,
    });
  } catch (e) {
    if (prepared) await page(token, 'restore').catch(() => {});
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    await bg('fail', { token, message: String((e && e.message) || e) }).catch(() => {});
  }
}

// ---------------------------------------------------------------- revokes

const revokeTimers = new Map();

function scheduleRevoke(url, delay) {
  if (revokeTimers.has(url)) return;
  revokeTimers.set(
    url,
    setTimeout(() => revoke(url), delay),
  );
}

function revoke(url) {
  const t = revokeTimers.get(url);
  if (t) clearTimeout(t);
  revokeTimers.delete(url);
  URL.revokeObjectURL(url);
}

// --------------------------------------------------------------- plumbing

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return undefined;
  if (msg.type === 'run') {
    // Idempotent by token, because the worker retries a send it did not get an
    // answer to and a lost *response* looks exactly like a lost request.
    if (msg.token === activeToken) {
      sendResponse({ value: { started: true } });
      return undefined;
    }
    // A new run supersedes rather than being refused. Refusing is only safe if
    // the flag that says "still running" is guaranteed to clear, and this
    // document has already disproved that once: a single unsettleable promise
    // inside `capture()` locked the extension out of every later capture until
    // Chrome was restarted. The worker is the sole owner of run identity — it
    // cancels the previous run before sending this one — so a stale loop still
    // in flight here fails on its next RPC with "capture was cancelled" and
    // unwinds itself.
    activeToken = msg.token;
    sendResponse({ value: { started: true } });
    capture(msg.token, msg.options).finally(() => {
      if (activeToken === msg.token) activeToken = null;
    });
    return undefined;
  }
  if (msg.type === 'revoke') {
    revoke(msg.url);
    sendResponse({ value: true });
    return undefined;
  }
  sendResponse({ error: `unknown message type ${msg.type}` });
  return undefined;
});
