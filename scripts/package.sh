#!/usr/bin/env bash
# Build the Chrome Web Store upload: dist/just-screenshot-it-<version>.zip
#
# Only what runs goes in the package. Tests, docs, SVG sources and the README
# stay in the repository — a reviewer reads the source on GitHub, and every
# extra file in the ZIP is another thing to justify.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/just-screenshot-it-${VERSION}.zip"

rm -rf dist/pkg "$OUT"
mkdir -p dist/pkg/src dist/pkg/icons

cp manifest.json dist/pkg/
cp src/*.js src/*.html src/*.css dist/pkg/src/
cp icons/*.png dist/pkg/icons/

# The manifest is the contract: every file it names must be in the package, and
# a typo here is a rejected upload rather than a runtime error.
node - <<'JS'
const fs = require('fs');
const mf = JSON.parse(fs.readFileSync('dist/pkg/manifest.json', 'utf8'));
const referenced = new Set();
const walk = (v) => {
  if (typeof v === 'string') {
    if (/\.(js|html|css|png|json)$/.test(v)) referenced.add(v);
  } else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
};
walk(mf);
const missing = [...referenced].filter((p) => !fs.existsSync(`dist/pkg/${p}`));
if (missing.length) {
  console.error(`manifest references files that are not in the package:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`manifest references ${referenced.size} files, all present`);
JS

# Nothing in the package may reach the network or execute a string. The listing
# claims this in writing, so it is checked rather than asserted. Written in node
# because BSD grep has no lookahead and silently *errors* on the pattern that
# needs one, which reads as "clean" from a shell `if`.
node - <<'JS'
const fs = require('fs');
const path = require('path');
const offenders = [];
const patterns = [
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/\bimportScripts\s*\(/, 'importScripts()'],
  [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/, 'a network API'],
  [/https?:\/\/(?!www\.w3\.org|www\.example\.com)/, 'an absolute http(s) URL'],
];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!/\.(js|html|css)$/.test(entry.name)) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      for (const [re, what] of patterns) {
        if (re.test(line)) offenders.push(`${p}:${i + 1}  ${what}\n    ${line.trim()}`);
      }
    });
  }
};
walk('dist/pkg');
if (offenders.length) {
  console.error(`refusing to build; the package must not reach the network or execute a string:\n  ${offenders.join('\n  ')}`);
  process.exit(1);
}
console.log('no network APIs, no dynamic execution, no absolute URLs');
JS

(cd dist/pkg && zip -qr "../${OUT##*/}" .)
rm -rf dist/pkg

echo "built $OUT ($(du -h "$OUT" | tr -s ' ' | cut -f1))"
unzip -l "$OUT" | awk 'NR>3 && !/^-----/ && NF>3 {print "  " $4}' | grep -v '/$'
