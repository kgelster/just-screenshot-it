import test from 'node:test';
import assert from 'node:assert';

import { buildFilename, resolveTokens, slug, TOKENS, TOKEN_GROUPS } from '../src/filename.js';
import { DEFAULTS } from '../src/defaults.js';

const at = new Date(2026, 7, 14, 9, 5, 3); // 2026-08-14 09:05:03 local

const page = {
  url: 'https://www.example-store.com/collections/all/products/wide-brim-hat',
  title: 'Wide-Brim Hat — Sale | Example Café',
  ext: 'png',
  date: at,
};

test('the default template files by site, then by time, then by title', () => {
  assert.strictEqual(
    buildFilename(DEFAULTS.filenameTemplate, page),
    'screenshots/example-store.com/2026-08-14-090503-Wide-Brim-Hat-Sale-Example-Cafe.png',
  );
});

test('slug folds diacritics instead of blanking them', () => {
  assert.strictEqual(slug('Café Ünïcode'), 'Cafe-Unicode');
});

test('slug collapses runs of separators rather than stacking them', () => {
  assert.strictEqual(slug('Foo | Bar — Baz'), 'Foo-Bar-Baz');
  assert.strictEqual(slug('  leading and trailing  '), 'leading-and-trailing');
});

test('an empty token takes its neighbouring separator with it', () => {
  // The page has no <title>. The old builder substituted "page"; this one
  // leaves nothing behind, including the hyphen that was joining it on.
  const name = buildFilename('{host}-{title}.{ext}', { ...page, title: '' });
  assert.strictEqual(name, 'example-store.com.png');
});

test('a stem that resolves to nothing still gets a name, not just an extension', () => {
  const name = buildFilename('{title}.{ext}', { ...page, title: '' });
  assert.strictEqual(name, 'capture.png');
});

test('an empty template is a filename, not a crash', () => {
  assert.strictEqual(buildFilename('', page), 'capture.png');
  assert.strictEqual(buildFilename(undefined, page), 'capture.png');
});

test('{path} distinguishes two same-titled pages on one host', () => {
  const a = buildFilename('{host}-{path}.{ext}', page);
  const b = buildFilename('{host}-{path}.{ext}', {
    ...page,
    url: 'https://www.example-store.com/collections/all/products/narrow-hat',
  });
  assert.strictEqual(a, 'example-store.com-collections-all-products-wide-brim-hat.png');
  assert.notStrictEqual(a, b);
});

test('{path} on a root URL collapses instead of leaving a bare separator', () => {
  assert.strictEqual(
    buildFilename('{host}-{path}.{ext}', { ...page, url: 'https://example.com/' }),
    'example.com.png',
  );
});

test('{w} and {h} report the stitched image size', () => {
  assert.strictEqual(
    buildFilename('{host}-{w}x{h}.{ext}', { ...page, width: 1440, height: 8213 }),
    'example-store.com-1440x8213.png',
  );
});

test('a directory token that resolves to nothing does not leave an empty segment', () => {
  const name = buildFilename('shots/{host}/{title}.{ext}', { ...page, url: 'not a url' });
  assert.strictEqual(name, 'shots/Wide-Brim-Hat-Sale-Example-Cafe.png');
});

test('path traversal and absolute paths are stripped', () => {
  const name = buildFilename('/../../{host}.{ext}', page);
  assert.strictEqual(name, 'example-store.com.png');
  assert.ok(!name.startsWith('/'));
  assert.ok(!name.includes('..'));
});

test('the extension is never doubled and never missing', () => {
  assert.strictEqual(buildFilename('{host}.{ext}', page), 'example-store.com.png');
  assert.strictEqual(buildFilename('{host}', page), 'example-store.com.png');
  assert.strictEqual(buildFilename('{host}.png', page), 'example-store.com.png');
  assert.strictEqual(buildFilename('{host}.{ext}', { ...page, ext: 'jpg' }), 'example-store.com.jpg');
});

test('a very long title is trimmed but the folders are not', () => {
  const name = buildFilename(DEFAULTS.filenameTemplate, { ...page, title: 'x'.repeat(400) });
  assert.ok(name.length <= 180, `length ${name.length}`);
  assert.ok(
    name.startsWith('screenshots/example-store.com/2026-08-14-090503-'),
    `folders were trimmed: ${name}`,
  );
  assert.ok(name.endsWith('.png'));
});

test('the public token list matches what the resolver actually produces', () => {
  // The options page renders one insert button per entry in TOKEN_GROUPS. A
  // token listed there but missing from the resolver would put a literal
  // "{nope}" into every filename, and a token the resolver knows but the
  // groups omit would be unreachable from the UI.
  const resolved = Object.keys(resolveTokens({ ...page, width: 1, height: 1 }));
  assert.deepStrictEqual([...TOKENS].sort(), resolved.sort());
});

test('no token is listed in two groups', () => {
  const flat = TOKEN_GROUPS.flatMap((g) => g.tokens.map((t) => t.key));
  assert.strictEqual(new Set(flat).size, flat.length);
});

test('every token carries an accessible label for its insert button', () => {
  for (const group of TOKEN_GROUPS) {
    assert.ok(group.label, 'group without a heading');
    for (const token of group.tokens) {
      assert.ok(token.label, `token {${token.key}} has no label`);
    }
  }
});

test('no output carries a character Chrome rejects in a filename', () => {
  const nasty = 'a\\b:c*d?e"f<g>h|ij';
  const name = buildFilename('{host}/{title}.{ext}', { ...page, title: nasty });
  const segments = name.split('/');
  for (const s of segments) {
    assert.ok(!/[\\:*?"<>|]/.test(s), `illegal character in "${s}"`);
    assert.ok(s.length > 0, 'empty segment');
    assert.ok(s !== '.' && s !== '..', 'traversal segment');
  }
});
