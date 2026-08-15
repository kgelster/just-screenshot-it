// Pure settings helpers. No `chrome`, no DOM.
//
// Everything the options page does to a value between the input element and
// `chrome.storage.local` lives here, so it can be tested under `node --test`
// instead of only by clicking around a browser. The page keeps the event
// wiring; this file keeps the arithmetic and the rules.

import { BOUNDS } from './defaults.js';

/** Storage keeps a raw pixel count; the UI shows megapixels. */
export const MP = 1e6;

export const mpToPixels = (mp) => Math.round(Number(mp) * MP);
export const pixelsToMp = (px) => Math.round((Number(px) / MP) * 10) / 10;

/**
 * Coerce one numeric field to something storable.
 *
 * Returns `null` for anything unusable — empty, blank, `NaN`, `Infinity` — so
 * the caller can restore the previous value instead of writing a substitute.
 * The old `collect()` folded this case into `DEFAULTS[key]`, which meant
 * clearing a field for a moment quietly discarded a custom setting.
 *
 * Out-of-range is not the same as unusable: it clamps, and because the field
 * is rewritten from the stored value afterwards the clamp is visible.
 *
 * @returns {number|null}
 */
export function clampSetting(key, raw) {
  const bounds = BOUNDS[key];
  if (!bounds) return null;
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

/**
 * Guarantee a capture has somewhere to put its result.
 *
 * With both destinations off the pipeline still scrolls the page, still
 * stitches the canvas, still encodes it, and then reports success having
 * produced nothing (`offscreen.js:243,262`). The options page refuses to turn
 * off the last one, but the page is not the only writer — storage can already
 * hold that state from an older build or a devtools poke — so the invariant is
 * enforced again where a run reads its options.
 *
 * Downloads wins the tie because it leaves something behind.
 */
export function normalizeDestinations(options) {
  if (options.download || options.copyToClipboard) return options;
  return { ...options, download: true };
}

/**
 * Break the path `buildFilename` returned into its display parts.
 *
 * Takes the built string rather than the template, so the preview cannot
 * disagree with the download: there is exactly one implementation of the
 * naming rules and this is not it.
 *
 * @returns {{dirs: string[], stem: string, ext: string}}
 */
export function splitPreview(built) {
  const parts = String(built ?? '').split('/');
  const last = parts.pop() ?? '';
  const dot = last.lastIndexOf('.');
  return {
    dirs: parts,
    stem: dot > 0 ? last.slice(0, dot) : last,
    ext: dot > 0 ? last.slice(dot + 1) : '',
  };
}

/**
 * Would this template name every capture the same thing?
 *
 * True when the template is blank, and true when it carries no token at all —
 * a fixed string is a fixed filename, and Chrome will happily write
 * `shot (1).png` … `shot (57).png` before anyone notices.
 */
export function isDegenerateTemplate(template) {
  const text = String(template ?? '').trim();
  if (!text) return true;
  // {ext} alone still yields one name for every page.
  return !/\{(?!ext\})\w+\}/u.test(text);
}
