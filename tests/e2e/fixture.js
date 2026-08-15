// Shared scaffolding for the end-to-end suite: a throwaway working directory,
// the extension copy the rig can actually drive, and a static server for the
// capture fixtures.

import { existsSync, rmSync, mkdtempSync, mkdirSync, cpSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { launch, sleep, CHROME } from './chrome.js';

export const EXT = join(dirname(fileURLToPath(import.meta.url)), '../..');

if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set CHROME_PATH.`);
  process.exit(1);
}

export const WORK = mkdtempSync(join(tmpdir(), 'jsi-e2e-'));
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));

/** A do-nothing extension used as a neighbour in arbitration tests. */
export function neighbour(name) {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name,
      version: '1.0',
      permissions: ['downloads'],
      background: { service_worker: 'sw.js', type: 'module' },
    }),
  );
  writeFileSync(join(dir, 'sw.js'), 'globalThis.ready = true;\n');
  return dir;
}

/**
 * A copy of this extension with two rig-only deltas, both about *reaching* a
 * capture rather than performing one: an exported run entry point, because CDP
 * cannot click a toolbar button, and `<all_urls>`, because `activeTab` is only
 * granted by a real action click. Everything downstream is the shipping code.
 *
 * `name` keeps parallel copies apart; the unpacked extension id is derived from
 * the directory path, so two tests must not share one.
 */
export function instrumented(name = 'jsi') {
  const dir = join(WORK, name);
  cpSync(EXT, dir, { recursive: true, filter: (p) => !/node_modules|\/\.git|tests\/e2e/.test(p) });
  appendFileSync(
    join(dir, 'src/background.js'),
    '\nglobalThis.__test_startRun = startRun;\nglobalThis.__test_run = () => run;\n',
  );
  const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  mf.host_permissions = ['<all_urls>'];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
  return dir;
}

/** Serve `tests/fixtures` for the length of `fn`. */
export async function withServer(port, fn) {
  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: join(EXT, 'tests/fixtures'),
    stdio: 'ignore',
  });
  await sleep(900);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.kill('SIGKILL');
  }
}

export function browserFactory(basePort) {
  let port = basePort;
  return async function withBrowser(extensions, fn, opts = {}) {
    const p = port++;
    const browser = await launch({
      extensions,
      port: p,
      profileDir: join(WORK, `profile-${p}`),
      downloadDir: join(WORK, `downloads-${p}`),
      ...opts,
    });
    try {
      return await fn(browser);
    } finally {
      await browser.close();
    }
  };
}

export const relative = (browser, abs) => (abs ? abs.replace(`${browser.downloadDir}/`, '') : abs);
