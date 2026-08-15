// Thin RPC service worker.
//
// Every handler does one short thing and returns. The run loop lives in the
// offscreen document, because a service worker can be terminated mid-run and
// would strand the page with a hidden header and no scrollbars.
//
// The worker exists here only to do the things the offscreen document is not
// allowed to do: offscreen documents may use `chrome.runtime` and nothing
// else — no tabs, no downloads, no storage.

import { DEFAULTS } from './defaults.js';
import { buildFilename } from './filename.js';
import { normalizeDestinations } from './settings-util.js';

let run = null; // {token, tabId, windowId, url, title, done, total}
let lastCaptureAt = 0;
let creatingOffscreen = null;
const pendingRevokes = new Map(); // downloadId -> {url, tabId, requested}

// Extension messaging caps at 64 MiB and is JSON-only. The guard has to live
// on this side: an oversized data URL fails crossing the boundary, so the
// offscreen document never gets to measure the frame it was supposed to reject.
const MAX_FRAME_BYTES = 48 * 1024 * 1024;

// A worker restart wipes `run`, and the offscreen document's next RPC would
// then fail as "cancelled" — including the `restore` and `fail` that clean up
// after it. Session storage survives the restart, so an in-flight run can be
// re-adopted by token instead of being stranded.
const RUN_KEY = 'activeRun';
const persistRun = () =>
  chrome.storage.session.set({ [RUN_KEY]: run }).catch(() => {});
const forgetRun = () => chrome.storage.session.remove(RUN_KEY).catch(() => {});

async function adoptRun(token) {
  if (run || !token) return;
  let stored;
  try {
    ({ [RUN_KEY]: stored } = await chrome.storage.session.get(RUN_KEY));
  } catch {
    return;
  }
  if (!stored || stored.token !== token) return;
  run = stored;
  console.warn('[fullpage-shot] adopted a run that outlived the service worker');
  armNaming();
  setBadge(run.total ? `${run.done}/${run.total}` : '...', '#4c9fff');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ badge

// The handle for the pending "clear the badge in a few seconds" timer. It has
// to be cancellable: the error badge schedules a clear 6s out, and a second
// capture started inside that window would otherwise have its own progress
// badge wiped by the previous run's timer.
let badgeTimer = null;

function setBadge(text, color) {
  clearTimeout(badgeTimer);
  badgeTimer = null;
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

/** Clear the badge after `ms`, unless something sets it again first. */
function clearBadgeLater(ms) {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }, ms);
}

function setTitle(text) {
  chrome.action.setTitle({ title: text }).catch(() => {});
}

// ------------------------------------------------------------- offscreen

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['BLOBS', 'CLIPBOARD'],
      justification:
        'Stitch captured viewport frames onto a canvas and place the result on the clipboard.',
    })
    .catch((e) => {
      // Benign race: a restarted worker found a document already open.
      if (!/single offscreen|already/i.test(String(e && e.message))) throw e;
    });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// Never close the document while a blob URL it owns is still feeding a
// download — closing it revokes the blob out from under Chrome.
async function maybeCloseOffscreen() {
  if (run || pendingRevokes.size) {
    setTimeout(maybeCloseOffscreen, 15000);
    return;
  }
  try {
    if (!chrome.offscreen.hasDocument || (await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    /* already closed */
  }
}

// --------------------------------------------------------------- run start

async function getOptions() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  // The options page will not let you switch off the last destination, but it
  // is not the only writer, and a run with both off produces nothing at all.
  return normalizeDestinations({ ...DEFAULTS, ...stored });
}

async function startRun(tab) {
  if (!tab || tab.id == null) return;
  // A run may still be recorded in session storage from before a worker
  // restart. Adopt it purely so `endRun` can put that page back.
  if (!run) {
    try {
      const { [RUN_KEY]: stored } = await chrome.storage.session.get(RUN_KEY);
      if (stored) run = stored;
    } catch {
      /* nothing recorded */
    }
  }
  if (run) {
    await endRun('A capture was already running; it was cancelled.', true);
  }
  const token = crypto.randomUUID();
  run = {
    token,
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || '',
    title: tab.title || '',
    done: 0,
    total: 0,
  };
  await persistRun();
  // Armed here rather than next to `download()` so the registration has the
  // whole capture to reach the browser process. See `armNaming`.
  armNaming();
  setBadge('...', '#4c9fff');
  setTitle('Just Screenshot It: starting');

  // One try block around the whole startup. Anything that throws after the
  // script is injected — storage, offscreen creation, dispatch — must still
  // clear `run`, or every later attempt is treated as replacing a live run
  // that is not there.
  // The title is the only progress indicator a stalled startup has — the badge
  // still reads "..." — so each stage names itself. Hovering the toolbar
  // button then says which step a capture that never finished is sitting on.
  try {
    setTitle('Just Screenshot It: injecting the page controller');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/capture-page.js'],
    });
  } catch (e) {
    await endRun(`Cannot capture this page: ${(e && e.message) || e}`, true);
    return;
  }

  try {
    setTitle('Just Screenshot It: reading settings');
    const options = await getOptions();
    setTitle('Just Screenshot It: opening the offscreen document');
    await ensureOffscreen();
    setTitle('Just Screenshot It: handing off to the capture loop');

    // `createDocument()` can resolve before the document's module script has
    // registered its listener, so the first send may come back "Receiving end
    // does not exist". That is the only thing worth retrying: the offscreen
    // document supersedes rather than refuses, and treats a repeat of the same
    // token as the duplicate delivery it is.
    //
    // This used to retry on a *refusal* instead, waiting out a previous run
    // that was supposedly still unwinding. It was not unwinding. It was hung,
    // permanently, and the retry only decided how long to wait before saying
    // so — see `copyImage` in `src/offscreen.js`.
    let started = false;
    let lastError = null;
    for (let attempt = 0; attempt < 10 && !started; attempt += 1) {
      if (!run || run.token !== token) return; // superseded while waiting
      try {
        const res = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'run',
          token,
          options,
        });
        started = Boolean(res && res.value && res.value.started);
      } catch (e) {
        lastError = e;
      }
      if (!started) await sleep(200);
    }
    if (!started && run && run.token === token) {
      await endRun(
        'Could not start the capture: the offscreen document never answered' +
          `${lastError ? ` (${(lastError && lastError.message) || lastError})` : ''}.`,
        true,
      );
    }
  } catch (e) {
    if (run && run.token === token) {
      await endRun(`Could not start the capture: ${(e && e.message) || e}`, true);
    }
  }
}

function logToPage(tabId, message) {
  if (tabId == null) return;
  chrome.tabs
    .sendMessage(tabId, { target: 'page', method: 'log', args: { message } })
    .catch(() => {});
}

async function endRun(message, isError) {
  const finished = run;
  run = null;
  await forgetRun();
  if (finished) {
    // Awaited, not fired and forgotten. The page's `restore` is what
    // invalidates any still-running `prepare()`, and returning before it lands
    // is how a page ends up permanently scrolled with its scrollbars hidden.
    await chrome.tabs
      .sendMessage(finished.tabId, { target: 'page', method: 'restore', args: {} })
      .catch(() => {});
    if (message) logToPage(finished.tabId, message);
  }
  disarmNaming();
  // A queued name still unclaimed here means the naming event never fired for
  // it. Give it a grace period, then stand down anyway.
  if (namingArmed) setTimeout(() => disarmNaming(true), 30000);
  setBadge(isError ? '!' : '', isError ? '#d93025' : undefined);
  setTitle(message || 'Just screenshot it');
  if (isError) {
    console.warn('[fullpage-shot]', message);
    clearBadgeLater(6000);
  }
}

// ---------------------------------------------------------------- capture

/**
 * Confirm the run is still the current one and its tab is still the active tab
 * in its window, then hand back the windowId that was verified. Callers must
 * use the returned id rather than re-reading `run.windowId`, which a newer run
 * may have changed in the meantime.
 */
async function verifyTarget(token) {
  if (!run || run.token !== token) throw new Error('capture was cancelled');
  const { windowId, tabId } = run;
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (!run || run.token !== token) throw new Error('capture was cancelled');
  if (!active || active.id !== tabId) {
    throw new Error('the target tab is no longer active; capture aborted');
  }
  return windowId;
}

async function captureOnce(token, opts, intervalMs) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // Pace first, verify second. captureVisibleTab is window-scoped, so the
    // identity check is only worth anything if nothing can await between it
    // and the capture itself.
    const wait = Math.max(0, intervalMs - (Date.now() - lastCaptureAt));
    if (wait > 0) await sleep(wait);
    const windowId = await verifyTarget(token);
    try {
      lastCaptureAt = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
      // Verify again: the tab could have changed while the capture was in
      // flight, in which case these pixels belong to a different page.
      await verifyTarget(token);
      return dataUrl;
    } catch (e) {
      lastError = e;
      const msg = String((e && e.message) || e);
      if (/MAX_CAPTURE|quota|too many/i.test(msg) && attempt < 3) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

async function captureFrame(token, { format, quality, intervalMs }) {
  const interval = intervalMs || DEFAULTS.captureIntervalMs;
  const png = format !== 'jpeg';
  const dataUrl = await captureOnce(
    token,
    png ? { format: 'png' } : { format: 'jpeg', quality },
    interval,
  );
  if (!png || dataUrl.length <= MAX_FRAME_BYTES) return dataUrl;

  // Too big to survive the trip to the offscreen document. Re-shoot as JPEG
  // here, before it ever crosses the boundary.
  console.warn('[fullpage-shot] frame too large for messaging; re-capturing as JPEG');
  return captureOnce(token, { format: 'jpeg', quality }, interval);
}

// --------------------------------------------------------------- download

/**
 * Names this extension has asked Chrome to use, oldest first.
 *
 * `downloads.download({filename})` is not enough on its own, and the reason is
 * none of the three things earlier attempts assumed. Measured on Chrome 151
 * with a throwaway profile and one extension loaded; the rows that still
 * matter are pinned in `tests/e2e/download-naming.test.js`:
 *
 *   no onDeterminingFilename listener anywhere ....... the name is kept
 *   a listener that returns without suggesting ....... the name is LOST
 *   a listener that calls bare `suggest()` ........... the name is LOST
 *   a listener that echoes back `item.filename` ...... the name is LOST
 *   a listener that suggests the name we want ........ the name is kept
 *
 * So the moment *any* installed extension registers a listener, Chrome throws
 * away the `filename` passed to `download()` and falls back to a name derived
 * from the URL — a blob URL's UUID, or `download.png` for a data URL. It does
 * not report this: the promise resolves and the download succeeds. The
 * culprit on the machine this was found on was Image Downloader, whose
 * listener bare-`suggest()`s every download it did not start.
 *
 * The only way back is to answer the event with a real suggestion. Identity
 * comes from `item.byExtensionId`, which Chrome populates with the id of the
 * extension that called `download()` — not from URL matching, which an earlier
 * attempt tried and which fails because the event does not carry the URL
 * string we passed. This extension runs one capture at a time, so a short FIFO
 * covers the case where a settle overlaps the next request.
 */
const wantedNames = [];

function nameDownload(item, suggest) {
  if (item.byExtensionId !== chrome.runtime.id || !wantedNames.length) {
    // Not ours. There is no way to abstain — a listener that suggests nothing
    // still makes Chrome discard the name the initiator asked for — so the
    // only real protection for other extensions is the listener not being
    // registered at all, which is what arm/disarm below is for.
    suggest();
    return false;
  }
  suggest({ filename: wantedNames.shift(), conflictAction: 'uniquify' });
  return false; // answered synchronously; `true` is only for async suggests
}

/**
 * The listener is registered only while a capture is running.
 *
 * Chrome settles competing suggestions by install recency, and measurement
 * showed that a *later-installed* extension answering "no opinion" beats an
 * earlier-installed one answering with a real name. So a permanently
 * registered listener here would silently break the filenames of every
 * downloads extension installed before this one.
 *
 * Arming is safe against the obvious race. `addListener` returns before its
 * registration reaches the browser process, so arming immediately before
 * `download()` could miss the event; arming at the start of a run puts script
 * injection, the lazy-load pre-pass, every frame capture and the PNG encode in
 * between, which is hundreds of milliseconds at the very least. If it ever
 * does miss, the requested-versus-saved comparison in `settleDownload` reports
 * it rather than leaving it silent.
 */
let namingArmed = false;

function armNaming() {
  if (namingArmed) return;
  namingArmed = true;
  chrome.downloads.onDeterminingFilename.addListener(nameDownload);
}

/**
 * Stand down, unless a name is still waiting to be claimed.
 *
 * Deliberately not gated on the download having *finished* — the naming event
 * fires while `download()` is still in flight, so by the time a run ends the
 * listener has already done its job. `force` is the backstop for a download
 * that is never settled at all, e.g. one the user pauses: staying armed
 * indefinitely would quietly restore the behaviour arm/disarm exists to avoid.
 */
function disarmNaming(force = false) {
  if (!namingArmed) return;
  if (!force && wantedNames.length) return;
  namingArmed = false;
  wantedNames.length = 0;
  chrome.downloads.onDeterminingFilename.removeListener(nameDownload);
}

/** Drop a queued name that will never be claimed, so the FIFO cannot drift. */
function unwant(filename) {
  const i = wantedNames.indexOf(filename);
  if (i >= 0) wantedNames.splice(i, 1);
}

async function startDownload(token, { url, ext, template, pageUrl, pageTitle, width, height }) {
  if (!run || run.token !== token) throw new Error('capture was cancelled');

  // The page's own `location.href` and `document.title`, reported by
  // `measure()`, in preference to the tab record. Under `activeTab` a tab
  // object can arrive with both fields empty — the permission is granted for
  // the capture, not retroactively for the object the event handler was
  // already holding — and every capture then lands as "page-<timestamp>".
  const filename = buildFilename(template || DEFAULTS.filenameTemplate, {
    url: pageUrl || run.url,
    title: pageTitle || run.title,
    ext,
    width,
    height,
  });

  // Queued before the call, because `onDeterminingFilename` fires during
  // `download()` and not after it resolves.
  wantedNames.push(filename);

  let id;
  try {
    id = await chrome.downloads.download({ url, filename, saveAs: false });
  } catch (e) {
    // Chrome rejected the name. Save the capture under a dull one rather than
    // losing it: a download that never starts also never revokes its blob, and
    // the user is left with nothing to show for the wait.
    console.warn(`[fullpage-shot] rejected filename "${filename}":`, e);
    unwant(filename);
    const fallback = `screenshots/capture-${Date.now()}.${ext}`;
    wantedNames.push(fallback);
    try {
      id = await chrome.downloads.download({ url, filename: fallback, saveAs: false });
    } catch (e2) {
      unwant(fallback);
      throw e2;
    }
    track(id, { url, tabId: run.tabId, requested: fallback });
    return { id, filename: fallback };
  }

  track(id, { url, tabId: run.tabId, requested: filename });
  return { id, filename };
}

/**
 * Record a download and settle it if it has already finished.
 *
 * A blob URL downloads instantly, so `onChanged` can fire with
 * `state: complete` **before** `downloads.download()` resolves and gives us an
 * id to record. The listener then finds nothing in `pendingRevokes`, returns,
 * and the entry we add a moment later is never removed. That leaks the
 * stitched PNG's blob for the life of the document, and because
 * `maybeCloseOffscreen()` refuses to close while `pendingRevokes.size` is
 * non-zero, the offscreen document is never closed either.
 */
function track(id, entry) {
  pendingRevokes.set(id, entry);
  chrome.downloads
    .search({ id })
    .then(([item]) => {
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        settleDownload(id, item.state);
      }
    })
    .catch(() => {});
}

async function settleDownload(id, value) {
  // Whichever of the listener and the post-hoc check gets here first wins;
  // the other finds the entry already gone.
  if (!pendingRevokes.has(id)) return;
  const pending = pendingRevokes.get(id);
  pendingRevokes.delete(id);
  // The naming event has long since fired for this download, but a rejected
  // or superseded request can leave its name behind.
  unwant(pending.requested);
  disarmNaming();
  chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'revoke', url: pending.url })
    .catch(() => {});
  try {
    const [item] = await chrome.downloads.search({ id });
    const saved = (item && item.filename) || '';
    logToPage(
      pending.tabId,
      `download ${value}: requested "${pending.requested}", saved "${saved || '?'}"`,
    );

    // Also recorded where it can be read without opening DevTools. The
    // options page shows it, which is the only way a naming failure is
    // visible to someone who is not debugging the extension.
    chrome.storage.local
      .set({
        lastCapture: {
          at: Date.now(),
          state: value,
          requested: pending.requested,
          saved,
        },
      })
      .catch(() => {});

    // Chrome can drop the requested name silently, so the two are compared
    // rather than merely printed side by side. `filename` comes back as an
    // absolute path, so only the tail is comparable.
    if (value === 'complete' && saved && !saved.endsWith(pending.requested)) {
      const message =
        `Chrome saved this capture as "${saved.split(/[\\/]/).pop()}" instead of ` +
        `"${pending.requested}". Another download manager extension is renaming ` +
        `it. Chrome gives the most recently installed extension the last word, ` +
        `so removing and re-adding Just Screenshot It puts it back in front.`;
      console.warn('[fullpage-shot]', message);
      logToPage(pending.tabId, message);
    }
  } catch {
    /* nothing to report */
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !pendingRevokes.has(delta.id)) return;
  const value = delta.state.current;
  if (value !== 'complete' && value !== 'interrupted') return;
  settleDownload(delta.id, value);
});

// ------------------------------------------------------------ RPC dispatch

async function handle(msg) {
  // The worker may have restarted since this run began. Recover its identity
  // from session storage before deciding the caller is stale.
  if (!run && msg.token) await adoptRun(msg.token);

  switch (msg.type) {
    case 'page': {
      if (!run || run.token !== msg.token) throw new Error('capture was cancelled');
      const res = await chrome.tabs.sendMessage(run.tabId, {
        target: 'page',
        method: msg.method,
        args: msg.args || {},
      });
      if (!res) throw new Error('the page stopped responding');
      if (res.error) throw new Error(res.error);
      return res.value;
    }
    case 'capture':
      return captureFrame(msg.token, msg);
    case 'download':
      return startDownload(msg.token, msg);
    // Commentary only: names the stage in the tooltip while the badge is still
    // on "...", so a long pre-pass does not look like a hang.
    case 'phase': {
      if (!run || run.token !== msg.token) return null;
      setTitle(`Just Screenshot It: ${msg.label}`);
      return null;
    }
    case 'progress': {
      if (!run || run.token !== msg.token) return null;
      run.done = msg.done;
      run.total = msg.total;
      await persistRun();
      setBadge(`${msg.done}/${msg.total}`, '#4c9fff');
      setTitle(
        msg.done === 0
          ? `Just Screenshot It: capturing ${msg.total} frames`
          : `Just Screenshot It: frame ${msg.done} of ${msg.total}`,
      );
      return null;
    }
    // `done` and `fail` end the run, so they must prove they belong to it.
    // An abandoned run reporting its own cancellation would otherwise tear
    // down whichever run replaced it.
    case 'done': {
      if (!run || run.token !== msg.token) return null;
      const bits = [];
      if (msg.size) bits.push(`${msg.size} in ${msg.frames} frames`);
      if (msg.downloaded) bits.push(`saved as "${msg.filename}"`);
      if (msg.copied) bits.push('copied');
      if (msg.downscaled) bits.push(`downscaled to ${Math.round(msg.scale * 100)}%`);
      if (msg.warning) bits.push(msg.warning);
      await endRun(`Just Screenshot It: ${bits.join(', ') || 'done'}`, Boolean(msg.warning));
      if (!msg.warning) {
        setBadge('OK', '#188038');
        clearBadgeLater(2500);
      }
      setTimeout(maybeCloseOffscreen, 15000);
      return null;
    }
    case 'fail':
      if (!run || run.token !== msg.token) return null;
      await endRun(`Just Screenshot It: ${msg.message}`, true);
      setTimeout(maybeCloseOffscreen, 5000);
      return null;
    default:
      throw new Error(`unknown message type ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return undefined;
  handle(msg).then(
    (value) => sendResponse({ value }),
    (e) => sendResponse({ error: String((e && e.message) || e) }),
  );
  return true;
});

// ------------------------------------------------------------- entry points

chrome.action.onClicked.addListener((tab) => {
  startRun(tab);
});

// Settings.
//
// Clicking the toolbar button captures, so there is no popup to hang a gear on
// and the options page was reachable only through chrome://extensions. This
// puts it one right-click away on the button itself, which is where anyone
// would look for it.
//
// Menu creation is idempotent-by-removal rather than guarded: `onInstalled`
// fires on update as well as install, and creating an id that already exists
// throws.
const MENU_ID = 'fullpage-shot-options';

function installMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Screenshot settings',
      contexts: ['action'],
    });
    void chrome.runtime.lastError; // a duplicate id here is not worth a log line
  });
}

chrome.runtime.onInstalled.addListener(installMenu);
chrome.runtime.onStartup.addListener(installMenu);

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_ID) chrome.runtime.openOptionsPage();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-full-page') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  startRun(tab);
});

// ------------------------------------------------------------ abort guards

chrome.tabs.onActivated.addListener((info) => {
  if (run && info.windowId === run.windowId && info.tabId !== run.tabId) {
    endRun('Just Screenshot It: aborted, you switched tabs mid-capture', true);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (run && tabId === run.tabId) endRun('Just Screenshot It: aborted, the tab closed', true);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!run || tabId !== run.tabId) return;
  if (changeInfo.status === 'loading' || (changeInfo.url && changeInfo.url !== run.url)) {
    endRun('Just Screenshot It: aborted, the page navigated mid-capture', true);
  }
});

// Deliberately NOT aborting on windows.onFocusChanged. captureVisibleTab is
// scoped to a windowId, so another window taking focus does not change which
// pixels come back; the per-frame active-tab check is what protects
// correctness. Aborting here would kill a run any time you click away.
