// Pure filename construction. No `chrome`, no DOM.
//
// Imported by the service worker, which names the download, and by the options
// page, which previews it. That sharing is the point: a preview computed by a
// second implementation is a preview that can disagree with the file you
// actually get.
//
// Chrome's `downloads.download` rejects a filename it does not like, and a
// rejected download is a lost capture. Everything here is arranged so the
// output is always something Chrome will accept: forward slashes survive as
// directory separators, nothing else does, no segment is empty or `.`/`..`,
// and there is always a stem in front of the extension even when every token
// resolved to nothing.

const MAX_SEGMENT = 64;
const MAX_TOTAL = 180;

/** The stem used when a template resolves to nothing usable. */
const LAST_RESORT = 'capture';

/** Combining marks left behind by the NFKD fold, so "Café" ends up "Cafe". */
const COMBINING = /\p{Mn}/gu;

/**
 * Everything that becomes a hyphen.
 *
 * `\p{Pd}` catches en and em dashes, which page titles are full of and which
 * NFKD does not decompose. Without it "Hat — Sale" keeps a literal em dash in
 * the filename. `\p{Zs}` catches non-breaking and hair spaces, `\p{C}` catches
 * control characters and zero-width joiners, and the literal set is what
 * Windows and Chrome reject outright.
 *
 * Deliberately a blacklist rather than an `[^A-Za-z0-9]` whitelist, because a
 * whitelist reduces any title that is not Latin script to a row of hyphens.
 */
const UNSAFE = /[\p{C}\p{Zs}\p{Pd}\\/:*?"<>|]/gu;

/** The same, minus the forward slash, for use after the path has been split. */
const UNSAFE_IN_SEGMENT = /[\p{C}\p{Zs}\p{Pd}\\:*?"<>|]/gu;

const trimEdges = (s) => s.replace(/^[-.\s]+/u, '').replace(/[-.\s]+$/u, '');

/**
 * Reduce one token's value to something safe inside a path segment.
 *
 * Runs of hyphens collapse: a title like "Foo | Bar — Baz" should read
 * "Foo-Bar-Baz", not "Foo---Bar-----Baz".
 */
export function slug(value, max = MAX_SEGMENT) {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(COMBINING, '')
    .replace(UNSAFE, '-')
    .replace(/-{2,}/gu, '-');
  return trimEdges(trimEdges(cleaned).slice(0, max));
}

/**
 * Clean an assembled path segment.
 *
 * Runs after substitution, which is where an empty token shows up as the
 * damage it did: `{host}-{title}` with no title leaves a dangling hyphen. Any
 * hyphen touching a dot is absorbed into it.
 */
function cleanSegment(segment) {
  return trimEdges(
    String(segment)
      .replace(UNSAFE_IN_SEGMENT, '-')
      .replace(/-{2,}/gu, '-')
      .replace(/-*\.-*/gu, '.')
      .replace(/\.{2,}/gu, '.'),
  );
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * The token table for one capture.
 *
 * `url` and `title` should be the values the *page* reported, not the ones on
 * the tab record. Under `activeTab` alone a tab object can arrive with `url`
 * and `title` empty, which is how every capture ends up named "page".
 */
export function resolveTokens({ url, title, ext, date, width, height }) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();

  let host = '';
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./u, '');
    path = parsed.pathname;
  } catch {
    /* not a URL we can parse; both stay empty and collapse out */
  }

  return {
    host: slug(host),
    title: slug(title),
    path: slug(path.replace(/^\/+|\/+$/gu, '')),
    yyyy: String(d.getFullYear()),
    mm: pad(d.getMonth() + 1),
    dd: pad(d.getDate()),
    hh: pad(d.getHours()),
    mi: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    w: width > 0 ? String(Math.round(width)) : '',
    h: height > 0 ? String(Math.round(height)) : '',
    ext,
  };
}

/**
 * Every token, grouped the way the options page presents them.
 *
 * The `label` is the token's accessible name on its insert button — "Insert
 * page title" reads better than "Insert {title}", and a screen reader gets
 * something other than punctuation.
 *
 * This is the presentation order. The *authority* on which tokens exist is
 * still `resolveTokens`, and `tests/filename.test.js` asserts the two agree —
 * a token listed here but absent from the resolver would render a chip that
 * inserts a literal `{nope}` into every filename.
 */
export const TOKEN_GROUPS = [
  {
    label: 'Page',
    tokens: [
      { key: 'host', label: 'site' },
      { key: 'title', label: 'page title' },
      { key: 'path', label: 'URL path' },
    ],
  },
  {
    label: 'Date and time',
    tokens: [
      { key: 'yyyy', label: 'year' },
      { key: 'mm', label: 'month' },
      { key: 'dd', label: 'day' },
      { key: 'hh', label: 'hour' },
      { key: 'mi', label: 'minute' },
      { key: 'ss', label: 'second' },
    ],
  },
  {
    label: 'Image',
    tokens: [
      { key: 'w', label: 'width' },
      { key: 'h', label: 'height' },
      { key: 'ext', label: 'file extension' },
    ],
  },
];

/** Every token the template understands, flattened out of the groups above. */
export const TOKENS = TOKEN_GROUPS.flatMap((g) => g.tokens.map((t) => t.key));

/**
 * @param {string} template
 * @param {object} ctx
 * @param {string} ctx.url      the page's own `location.href`
 * @param {string} ctx.title    the page's own `document.title`
 * @param {string} ctx.ext      'png' or 'jpg'
 * @param {Date}   [ctx.date]
 * @param {number} [ctx.width]  final image width in px, for {w}
 * @param {number} [ctx.height] final image height in px, for {h}
 * @returns {string} a relative path Chrome will accept
 */
export function buildFilename(template, ctx) {
  const ext = slug(ctx.ext || 'png', 8).toLowerCase() || 'png';
  const suffix = `.${ext}`;
  const tokens = resolveTokens({ ...ctx, ext });

  const substituted = String(template || '').replace(/\{(\w+)\}/gu, (whole, key) =>
    key in tokens ? tokens[key] : whole,
  );

  // The extension comes off before the last segment is cleaned, not after.
  // Cleaning first would strip the leading dot from a stem that reduced to
  // nothing, turning `{title}.{ext}` on an untitled page into a file called
  // "png.png" — named after its own format.
  const parts = substituted.split('/');
  let lastRaw = parts.pop() ?? '';
  if (lastRaw.toLowerCase().endsWith(suffix)) lastRaw = lastRaw.slice(0, -suffix.length);

  // Empty segments come from a leading slash or a directory token that
  // resolved to nothing. `.` and `..` Chrome rejects outright.
  const usable = (s) => s && s !== '.' && s !== '..';
  const dirs = parts.map(cleanSegment).filter(usable);
  let stem = cleanSegment(lastRaw);
  if (!usable(stem)) stem = LAST_RESORT;

  // Trim the stem, never the directories: the folder is how the file gets
  // found again, and truncating it would scatter one site's captures.
  const prefix = dirs.join('/');
  const room = MAX_TOTAL - (prefix ? prefix.length + 1 : 0) - suffix.length;
  if (room > 8 && stem.length > room) stem = trimEdges(stem.slice(0, room)) || LAST_RESORT;

  return [...dirs, stem + suffix].join('/');
}
