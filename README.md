# Just Screenshot It

A Manifest V3 Chrome extension that captures the entire scrollable page as one
image, saves it to Downloads, and puts it on the clipboard. One keystroke, no
yellow "is debugging this browser" banner, no account, no telemetry, **no host
permissions**.

Written from scratch after GoFullPage went closed-source and was pulled from the
Web Store. No GoFullPage code was copied or consulted.

MIT licensed. Every network-facing claim above is checkable in this repository:
the whole package is plain, unminified JavaScript and it makes no requests at
all.

## Install

Not on the Chrome Web Store yet ([why](#publishing)). Load it unpacked:

1. Clone or download this repository.
2. `chrome://extensions` → turn on **Developer mode** (top right).
3. **Load unpacked** → select the directory holding `manifest.json`.
4. `chrome://extensions/shortcuts` → confirm **Capture the full page** is bound.
   Chrome silently leaves a suggested shortcut unassigned when another extension
   already owns it. The options page reads the real binding back and will tell
   you if it is blank.

Default shortcut: `Command+Shift+Y` on macOS, `Ctrl+Shift+Y` elsewhere. Clicking
the toolbar button does the same thing.

To capture local files, also enable **Allow access to file URLs** on the
extension's details page.

## How it works

`captureVisibleTab` can only photograph what is on screen, so a full page means
scrolling and stitching: an injected controller scrolls and measures the page, a
persistent offscreen document owns the run and stitches frames onto a canvas, and
the service worker does the privileged calls. Sticky headers, scroll snap, lazy
loading, browser zoom, tab switches mid-run and Chrome's two-captures-per-second
quota each get their own defence.

Why each of those is built the way it is, with the Chrome behaviour measured
behind it: [docs/design-notes.md](docs/design-notes.md).

## Options

**Right-click the toolbar button → Screenshot settings.** Clicking the button
captures, so there is no popup to hang a gear icon on; the context menu is the
way in. `chrome://extensions` → Just Screenshot It → **Extension options** still
works.

**Output**

- **Filename** template, with token chips, three presets and a live preview
- **Image format** and **JPEG and fallback quality**. The quality value is not
  ignored under PNG: it is also what a single oversized frame is re-encoded at
  when it will not fit through extension messaging, so the control stays live
  and says so.
- **Save to Downloads** / **Copy to clipboard**

**Capture behaviour**

- **Lazy-load pre-pass** — scroll once before measuring so lazy images load.
  Turn it off for feeds that grow forever.
- **Full-screen overlays** — `keep` (a cookie wall appears once, where it sits)
  or `strip` (hidden from every frame). `keep` is the default because stripping
  removes real content on pages whose body is a dialog.
- **Advanced**, collapsed: **settle delay**, **capture interval**, **pixel
  budget**. The budget is entered in megapixels rather than as an eight-digit
  pixel count, and the page states what the current value costs you: at 40 MP a
  1440px-wide page starts downscaling past about 6,900px tall on a 2× display.
  That figure falls with the *square* of the device pixel ratio, because the
  canvas is `(vw · dpr) × (ph · dpr)`.

The capture interval floor is not tunable past reality: Chrome caps
`captureVisibleTab` at 2 calls per second and the limit cannot be raised, so a
twelve-viewport page takes roughly seven seconds.

### How the page behaves

- **Changes save themselves.** There is no Save button. Toggles, radios and
  selects write on change; number fields on change and blur; the filename is
  debounced and flushed immediately on blur or Enter, with the pending debounce
  cancelled so a stale delayed write cannot land after it. Every write carries
  a monotonic revision and only the newest one is allowed to report, so a slow
  success cannot overwrite a fast failure's message. This is
  `chrome.storage.local`, not `storage.sync`, so there is no per-minute write
  quota to pace against.
- **An unusable number reverts to the value you had.** Empty or non-numeric
  input restores the stored value and says so. It does *not* substitute the
  default, which is what the previous page did — clearing a field for a moment
  silently discarded a custom setting. Out-of-range input clamps, and the field
  is rewritten so you can see the clamp.
- **One destination always stays on.** Turning off the last of Downloads and
  clipboard is refused, because a capture with neither still scrolls, stitches,
  encodes and reports success while producing nothing. The UI is not the only
  writer, so the same rule is re-applied in `getOptions()` where a run reads its
  settings.
- **The shortcut shown is the real one.** It comes from `chrome.commands.getAll()`,
  not from the manifest's suggestion. When a suggested key collides Chrome drops
  it silently, and a blank shortcut here is the only signal you get.
- **Restore defaults takes two clicks.** No undo window: ten local values, all
  visible immediately, on a page nobody visits twice.

### Filenames

Default: `screenshots/{host}/{yyyy}-{mm}-{dd}-{hh}{mi}{ss}-{title}.{ext}`

A folder per site, time-first inside it, then the page's own title. The old
default was `{host}` and a timestamp in one flat folder, which is the wrong
unit: shooting six pages of one store produced six files distinguishable only
by the second they were taken. Sorting by name inside a site folder now sorts
by when it was taken, and the title is there to read.

Tokens: `{host}` `{title}` `{path}` `{yyyy}` `{mm}` `{dd}` `{hh}` `{mi}` `{ss}`
`{w}` `{h}` `{ext}`. Slashes make subfolders of Downloads. `{path}` is the URL
path flattened, which is how two identically-titled pages on one host stay
apart; `{w}` and `{h}` are the stitched image's pixel dimensions.

Three things the builder guarantees, because `downloads.download` rejects a
name it dislikes and a rejected download is a lost capture:

- **A token that resolves to nothing takes its separator with it.** An untitled
  page gives `example.com.png`, not `example.com-.png`.
- **There is always a stem.** `{title}.{ext}` on an untitled page would
  otherwise reduce to `png.png`, a file named after its own format. It falls
  back to `capture`.
- **Only the stem gets truncated.** The total is capped at 180 characters and
  the directories are never trimmed, because the folder is how the file is
  found again.

The preview on the options page calls the same `buildFilename` the download
does. A preview written twice is a preview that can lie.

## What the toolbar button tells you

| Badge | Meaning |
|---|---|
| `...` blue | starting: injecting, reading settings, opening the offscreen document |
| `3/12` blue | drawing frame 3 of 12 |
| `OK` green | done, clears after 2.5 s |
| `!` red | failed, clears after 6 s. Hover for the reason |

The badge stays on `...` through the lazy-load pre-pass, which scrolls the
whole page and is the longest part of a tall capture. **Hover the button** —
the tooltip names the current stage ("loading lazy content", "measuring the
page") so a slow capture is distinguishable from a hung one. That distinction
was not there before 2026-08-14, and a working 2.4 MB capture of a long
dashboard read as a dead button for about fifteen seconds.

## Publishing

Not listed on the Chrome Web Store yet. `npm run package` builds
`dist/just-screenshot-it-<version>.zip` containing only what runs, and
`npm run store-assets` builds the listing images. Every field the dashboard asks
for, including the per-permission justifications and the privacy-form answers, is
written out in [docs/store-listing.md](docs/store-listing.md); the privacy policy
is [PRIVACY.md](PRIVACY.md).

The extension requests **no host permissions**: `activeTab`, `scripting`,
`downloads`, `offscreen`, `storage`, `clipboardWrite`, `contextMenus`, and
nothing else. Do not add `<all_urls>` for convenience.

Windows and Linux are unverified. Everything measured here is macOS, and the
clipboard behaviour in particular is measured against the macOS pasteboard.

## Known limits

- **Chrome's own pages.** Script injection is blocked on `chrome://`,
  `chrome-extension://`, and Web Store URLs, so full-page capture is
  unsupported there.
- **`file://` URLs** need "Allow access to file URLs" enabled manually.
- **Cross-origin iframes** show only their first viewport. The extension cannot
  scroll them.
- **Virtualised and infinite-scroll feeds** snapshot the page height at measure
  time, not the whole feed.
- **Horizontal overflow** is cropped to the visible column. The canvas is one
  viewport wide by design; capturing both axes doubles the stitching bugs for a
  case that almost never comes up.
- **Closed shadow roots** are invisible to the pinned-element scan, so a sticky
  header inside one will repeat.
- **Browser zoom** is handled by deriving the CSS-to-bitmap ratio from the
  decoded frame rather than trusting `devicePixelRatio`, but the zoom matrix is
  not systematically tested.
- **The clipboard copy pastes into rich text, not into pixel editors.** Only an
  HTML flavour reaches the system clipboard from an offscreen document, so Slack
  and Gmail get the image and Preview and Photoshop get nothing. Captures over
  24 MB skip the copy entirely. See [Why the clipboard is the awkward
  part](docs/design-notes.md#why-the-clipboard-is-the-awkward-part).
- **`windows.onFocusChanged` does not abort a run.** `captureVisibleTab` is
  scoped to a windowId, so another window taking focus does not change which
  pixels come back; the per-frame active-tab check is what protects
  correctness. Aborting on focus change would kill a run every time you clicked
  away.

## Tests

Unit tests cover the three pure modules — `src/plan.js` (all the arithmetic),
`src/filename.js` (all the naming) and `src/settings-util.js` (the options
behaviour). None of them touches `chrome` or the DOM:

```
npm test
```

### End-to-end

`tests/e2e/` launches a real Chrome, loads this extension into a throwaway
profile, and runs actual captures against a fixture page:

```
npm run test:e2e          # ~160s, needs Chrome; CHROME_PATH overrides the path
```

| File | Covers |
|---|---|
| `download-naming.test.js` | the file lands under the templated name with a rival downloads extension installed, an idle capture extension leaves other extensions' filenames alone, and the decision table above |
| `capture-lifecycle.test.js` | three captures in a row all succeed and each returns the worker to idle, plus the offscreen-document facts in [Why the clipboard is the awkward part](docs/design-notes.md#why-the-clipboard-is-the-awkward-part) |
| `chrome.js` | dependency-free CDP driver |
| `fixture.js` | throwaway workspace, the instrumented extension copy, the static server |

This exists because extension pages and the toolbar button are both out of
reach for ordinary browser automation, which made three consecutive filename
fixes unverifiable — two of them were wrong and shipped anyway, and the
capture-once bug then survived a whole release for the same reason.
`tests/e2e/chrome.js` loads extensions with the CDP `Extensions.loadUnpacked`
command rather than `--load-extension`, which Chrome 137 removed from branded
builds. Files run one at a time (`--test-concurrency=1`): each one wants its own
Chrome, its own debugging port and its own fixture server.

The rig runs headless and cleans up after itself. Its one compromise: the
extension copy under test gets two rig-only deltas, an exported run entry point
(CDP cannot click a toolbar button) and `<all_urls>` (`activeTab` is granted
only by a real click). Both concern *reaching* a capture, not naming one, and
everything downstream is the shipping code.

### Fixtures

Manual capture targets live in `tests/fixtures/`. Every band on every fixture is
exactly 100 px tall and labelled with its index and document offset, so a
duplicated, missing, or torn band is obvious:

```
cd tests/fixtures
python3 -m http.server 8777
open http://127.0.0.1:8777/
```

| Fixture | What it proves |
|---|---|
| `sticky.html` | sticky header, sticky footer, and a sticky section with an absolutely positioned child each appear exactly once (expected height 3152 px) |
| `fixed-in-transform.html` | a `position: fixed` element inside a transformed ancestor is *not* hidden (3000 px) |
| `scroll-snap.html` | `scroll-snap-type: y mandatory` leaves no gaps (3000 px) |
| `lazy-grow.html` | the page grows during the pre-pass, 1500 px → 4000 px |
| `inner-scroller.html` | a scrolling pane inside a static shell is refused with a message |
| `overlay.html` | the keep/strip overlay option (2500 px) |
| `entropy.html` | near-incompressible frames exercise the messaging size guard |

Also worth doing by hand: switch tabs mid-capture (must abort with a red `!`
badge, not blend two pages), and capture the same page twice in a row (must not
double-register the injected listener).
