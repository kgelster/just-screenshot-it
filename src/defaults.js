// Shared option defaults. Imported by the service worker and the options page.
// Kept in its own module so the options page does not have to import
// background.js, which would register a second set of listeners.

export const DEFAULTS = {
  format: 'png',
  jpegQuality: 92,
  // A folder per site, then time-first inside it, then the page's own title.
  // `{host}` alone was the old default and it is the wrong unit: shooting six
  // pages of one store produced six files distinguishable only by a timestamp,
  // which is not how anyone looks for a screenshot afterwards. Sorting by name
  // inside a site folder now sorts by when it was taken.
  filenameTemplate: 'screenshots/{host}/{yyyy}-{mm}-{dd}-{hh}{mi}{ss}-{title}.{ext}',
  copyToClipboard: true,
  download: true,
  prePass: true,
  settleMs: 120,
  pixelBudget: 40000000,
  overlayPolicy: 'keep',
  captureIntervalMs: 600, // quota is 2 captures/sec and cannot be raised
};

/**
 * Per-field bounds for every numeric setting, in the units storage uses.
 *
 * Lives here rather than in the options page so the page can generate its
 * `min`/`max`/`step` attributes from the same object it clamps against. The
 * previous arrangement kept the numbers in markup and in JS and they drifted
 * twice: quality read `min="10"` against a JS floor of 1, and pixel budget read
 * `max="200000000"` against a JS ceiling of 4e8.
 *
 * A single "must be > 0" rule cannot express a settle delay of zero, which the
 * input itself offers, and it silently lets the capture interval go under the
 * 500ms floor that Chrome's 2-per-second quota imposes.
 */
export const BOUNDS = {
  jpegQuality: { min: 10, max: 100, step: 1 },
  settleMs: { min: 0, max: 2000, step: 10 },
  captureIntervalMs: { min: 500, max: 5000, step: 50 },
  pixelBudget: { min: 1e6, max: 2e8, step: 1e6 },
};
