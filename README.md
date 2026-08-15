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

Not on the Chrome Web Store yet; see **Publishing** below.

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
scrolling and stitching. Four pieces:

```
 hotkey / toolbar click
        │
        ▼
  background.js    thin RPC. Every handler does one short thing and returns.
        │          Listeners are registered at the top level so they survive a
        ▲ ▼        service-worker restart.
  offscreen.js     owns the run: canvas, frame index, target identity, retries.
        ▲ ▼
  capture-page.js  injected controller: measure, prepare, scroll, restore.
        │
        └────────► plan.js   pure math, no chrome and no DOM, unit-tested
```

The run loop deliberately does **not** live in the service worker. A worker can
be terminated between two captures, which would strand the page with a hidden
header and no scrollbars and nobody left to restore it. An offscreen document is
a persistent page, and its messages reset the worker's idle timer. It pays for
that by being allowed to call `chrome.runtime` and nothing else — no `tabs`, no
`downloads`, no `storage` — so every capture and every download is a round trip
through the worker.

Order of operations matters: the page is **prepared before it is measured**.
The lazy-load pre-pass and the capture CSS (hidden scrollbars, snap disabled)
both change `scrollHeight`, so measuring first plans for the wrong page.

### What each part defends against

| Failure | Defence |
|---|---|
| Capturing the wrong tab | `captureVisibleTab` takes a **windowId**, not a tabId. The target tab is verified immediately before *and* after every capture — after the quota pacing sleep, not before it, so nothing can await in between — and the verified windowId is what the capture is issued against. Tab activation, removal, and navigation all abort the run. |
| Page changes shape mid-run | Height is re-read every frame; a material change aborts rather than producing a torn image. |
| Scroll snap / scroll anchoring | `scroll-snap-type: none` and `overflow-anchor: none` during capture, two consecutive stable `scrollTop` readings after every scroll, covered intervals tracked and gaps retried. |
| Repeating sticky and fixed elements | Pinned-ness is decided **empirically** — is the element displaced from its natural document position right now — not by reading `position`. Each pinned element also gets one **home frame**: the frame whose band overlaps its natural band the most. It is hidden in every other frame, and exempt in its home frame so an always-pinned element (a `bottom: 0` sticky footer on a one-frame page) is not deleted outright. Merely testing "does its natural band touch this frame" re-draws a full-height sticky rail on any page where the rail overlaps the next frame by a few pixels. Hiding is `opacity: 0 !important`, which preserves layout; demoting `sticky` to `static` would change containing blocks and z-order. A `position: fixed` element inside a transformed ancestor scrolls with the page, is never displaced, and is therefore never hidden. |
| Overlapping frames erasing pinned content | The final frame is clamped to the bottom of the document, so it overlaps its predecessor — and because a pinned element is hidden outside its home frame, repainting that overlap would blank out a rail the earlier frame drew correctly. Sequential frames are first-writer-wins: `framePlacement` takes a `coveredTo` high-water mark and trims already-painted rows off the top of the source. A gap retry gets the mirror-image treatment, a `limitTo` bound, because it is scrolled to the top of the gap but still returns a whole viewport. |
| Seams and unpainted rows | Every edge is decided in document CSS px and rounded exactly once into canvas px and once into bitmap px; rounding an origin and a length separately puts one-pixel seams between frames. The vertical scale is passed in as `canvasHeight / pageHeight`, never inferred from the rounded canvas width — on a tall downscaled page the two differ enough to leave rows unpainted at the bottom, and `coverageGaps` cannot see it because it converts coverage back through the same wrong number. |
| Aborting mid-`prepare` | `prepare()` runs a lazy-load pre-pass that can take seconds. `restore()` bumps a generation counter, and `prepare()` re-checks it after every await, so a restore that lands mid-prepare cannot be followed by the still-running prepare installing capture CSS behind it. A `prepare()` that fails or is cancelled undoes its own partial work. |
| A stale run cancelling a live one | Every message that ends a run (`done`, `fail`) carries its token and is dropped if it does not match the current run. Without that, an abandoned run reporting its own cancellation tears down whichever run replaced it. |
| Inner scroll containers | v1 captures the root scroller, plus an inner scroller that fills the viewport (frames are cropped to it). Anything else is refused with a message rather than silently composited wrong. |
| Memory | An operational pixel budget (40M device px by default), not a constant scraped from Chromium. The canvas is probed before the run; on failure the budget halves and the plan is rebuilt. A downscale is reported, never silent. |
| Oversized frames | Extension messaging caps at 64 MiB and is JSON-only, so frames travel as data URLs. Above ~48 MiB the frame is re-captured as JPEG and the downgrade is logged. The check runs **in the worker**, before the frame is sent: an oversized data URL fails crossing the boundary, so measuring it on the offscreen side is a check that can never fire for exactly the frames it exists to catch. |
| A service worker restart mid-run | The worker's `run` record is mirrored into `chrome.storage.session`, which outlives it. When an RPC arrives carrying a token the restarted worker does not recognise, it re-adopts that run from session storage instead of rejecting the call — which would otherwise also reject the run's own `restore` and `fail`, stranding the page until the injected watchdog fired. |
| Clipboard | `navigator.clipboard` checks document focus before extension permission and an offscreen document can never be focused, so the deprecated `execCommand('copy')` path is used. The download happens **first** — a clipboard failure never costs the file — and the copy runs under a 15s ceiling, because a step that hangs here used to take the whole extension with it. See [Why the clipboard is the awkward part](#why-the-clipboard-is-the-awkward-part). |
| A step that never finishes | Every stage of the run loop is an `await` in one chain with no supervisor, so any one of them that never settles strands the capture silently. Anything crossing into browser-owned machinery gets a timeout, and a second capture **supersedes** a running one rather than being refused. Refusing is only safe if the "still running" flag is guaranteed to clear, and it was not: see below. |
| Captures named after nothing | The filename is built from the values the **page** reported through `measure()`, not from the tab record. `activeTab` is granted for the capture, not retroactively for the tab object the event handler was already holding, so `tab.url` and `tab.title` can both arrive empty and name every capture the same thing. If Chrome rejects the name anyway, the download retries once under a dull fallback rather than being dropped. |

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

Bounds live in `src/defaults.js` as `BOUNDS`, and the page generates its
`min`/`max`/`step` attributes from them. They used to be written out twice and
had drifted in both directions — quality read `min="10"` in markup against a JS
floor of 1, and the budget read `max="200000000"` against a JS ceiling of 4e8.

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

The options page renders one insert-at-cursor chip per token from
`TOKEN_GROUPS`, and `TOKENS` is derived by flattening that list. A test asserts
the flattened list equals the keys the resolver actually produces, so a token
cannot be offered in the UI without existing in the grammar, or exist in the
grammar without being reachable from the UI.

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

#### Why naming a download is harder than it looks

**Passing `filename` to `downloads.download()` is not enough**, and the reason
is not the one three attempts at this assumed. Measured on Chrome
151.0.7922.138 with a throwaway profile, one extension, and one variable at a
time (`tests/e2e/download-naming.test.js` pins the rows that still matter):

| `onDeterminingFilename` listeners in the profile | `filename` |
| --- | --- |
| none | **kept** — blob URL or data URL, subfolders included |
| one, returning without suggesting | lost |
| one, calling bare `suggest()` | lost |
| one, echoing `item.filename` back | lost |
| one, suggesting the wanted name | **kept** |

So the failure has nothing to do with blob URLs, folders, or the shape of the
name. The moment *any* installed extension registers a listener, Chrome
discards the `filename` that was passed to `download()` and falls back to a
name derived from the URL — the UUID for a blob URL, `download.png` for a data
URL — and it does not say so. The download succeeds and the promise resolves.

Two further findings, both of which cost a fix each:

- **`item.filename` in the event is Chrome's own default, never the name the
  initiator asked for.** A listener cannot pass through a name it does not own,
  so there is no polite way to abstain. Registering at all is the damage.
- **Ties are settled by install recency, not by who answered.** Contrary to the
  documented "last extension installed whose listener passes a suggestion
  object to `suggest` wins", a *later-installed* extension answering "no
  opinion" beats an earlier-installed one answering with a real name.

The listener that exposed this belongs to **Image Downloader**
(`cnpniohnfphhjihaiiggeabnkjhpaldj`), which bare-suggests every download it did
not start. To find the ones in your own profile:

```
grep -rl onDeterminingFilename \
  ~/Library/Application\ Support/Google/Chrome/<Profile>/Extensions/   # macOS
```

What the worker does about it:

- Registers a listener and answers with the name it already computed,
  identifying its own downloads by `item.byExtensionId === chrome.runtime.id`.
  That field is reliable; URL matching is not, because the event does not carry
  the URL string that was passed to `download()`.
- **Registers it only while a capture is running.** Since install recency
  decides and this extension is usually the newest, a permanently registered
  listener would silently break the filenames of every downloads extension
  installed before it. Arming happens at the start of a run rather than next to
  `download()`, so the registration has the whole capture — script injection,
  pre-pass, every frame, the PNG encode — to reach the browser process.
- Compares the saved path against the requested one on completion and, when
  they differ, says so on the options page with the remedy: Chrome gives the
  most recently installed extension the last word, so reinstalling this one
  puts it back in front.

An earlier revision base64'd the image into a data URL before downloading, on
the theory that blob URLs were the problem. They were not, in either direction:
a blob URL is named correctly when nothing interferes and a data URL is named
just as badly when something does. That conversion was removed — it cost a full
re-encode and a third again in size against the 64 MiB messaging cap, which is
what had put a ceiling on how tall a page could be saved.

If you saved options before 2026-08-14 you still have the old template stored.
**Restore defaults** adopts the new one.

### Why the clipboard is the awkward part

An offscreen document is a page with a DOM, which is what makes the run loop
possible — but it is **never rendered**, and a surprising amount of the platform
quietly depends on rendering. Measured on Chrome 151.0.7922.138, headed and
headless, and pinned in `tests/e2e/capture-lifecycle.test.js`:

| In an offscreen document | Result |
|---|---|
| `requestAnimationFrame(cb)` | never fires |
| `img.decode()` | **never settles**, including for a 1×1 PNG |
| `img.onload` | fires normally |
| `navigator.clipboard.write()` | throws `NotAllowedError: Document is not focused` |
| `execCommand('copy')` over a selected `<img>` | works |

The second row is the one that mattered. `copyImage()` awaited `img.decode()`,
so the run loop stopped there permanently: the capture never reported `done`,
the flag saying a capture was in progress never cleared, and every attempt after
the first was refused with *"Could not start the capture: the previous one is
still finishing"* until Chrome was restarted. The download had already happened
by then, which is why it looked like the extension worked exactly once per
browser session. It is not a size or memory effect — a 1×1 PNG hangs too. Waiting
on `load` instead is the fix; the timeout and the supersede-instead-of-refuse
handshake are there so the next unsettleable promise costs one capture rather
than all of them.

**What actually lands on the clipboard is HTML, not an image.** Chrome writes
only an HTML flavour from this path — verified against the macOS pasteboard,
which reports `«class HTML»` and no `«class PNGf»`. So the picture pastes into
Slack, Gmail, Docs and anything else that accepts rich text, and pixel editors
like Preview or Photoshop get nothing. Because HTML is all that survives, the
`<img>` has to carry a self-contained `data:` URL: the previous
`blob:chrome-extension://…` src was unresolvable outside this browser and pasted
as a broken image everywhere. A native image flavour would mean doing the copy
in the focused tab instead, which is a different design and is not built.

Captures above 24 MB skip the clipboard rather than inline that much base64;
the file is unaffected.

### What the toolbar button tells you

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

## Icons

Two sets, from four SVG sources. `icons/build-icons.sh` renders them and then
checks each PNG's dimensions **and mean alpha** — `sips -g pixelWidth` cannot
tell an accidentally opaque ground from a transparent one, and `%[opaque]` is
no help either because the tiles' rounded corners already make them
non-opaque. Line art lands near 0.2 mean alpha, a filled tile near 0.96.

| Set | Used by | Why |
|---|---|---|
| `glyph{16,32,48,128}.png` | `action.default_icon`, the toolbar button | Line art on a transparent ground, so it sits on whatever colour the toolbar is |
| `tile{16,32,48,128}.png` | the manifest `icons` key: `chrome://extensions`, the puzzle menu, permission dialogs | Those all render on the browser's own card, where a self-grounding filled square is right |

**Runtime light/dark swapping was considered and rejected.** The obvious design
is two icon sets and a `chrome.action.setIcon()` call driven by
`prefers-color-scheme`. It does not work. `prefers-color-scheme` reports the
browser and OS colour preference, not the colour Chrome paints the toolbar. A
custom Chrome theme, or Appearance set independently of the OS, makes them
disagree, and Chrome exposes no API for the actual toolbar colour. Declarative
theme-variant action icons were proposed for the manifest and never shipped. A
detector that cannot observe the thing it claims to observe is worse than no
detector, so the toolbar glyph is drawn to survive any ground instead.

It does that by keeping every colour inside the luminance band that clears 3:1
against both Chrome toolbars, light `#F1F3F4` (L=0.893) and dark `#292A2D`
(L=0.024) — that is L in [0.172, 0.265]:

| Colour | L | on light | on dark | used for |
|---|---|---|---|---|
| `#6B7A99` | 0.194 | 3.87:1 | 3.29:1 | page outline, text lines |
| `#3A7DF5` | 0.222 | 3.47:1 | 3.67:1 | arrow |

The product accent `#4C8DFF` measures L=0.275 and lands just outside the band
at 2.99:1 on a light toolbar, which is why the arrow uses the marginally deeper
`#3A7DF5`. Outline and arrow are close in luminance to each other on purpose:
they never touch, and a thin stroke against a solid fill is what separates them,
so nothing depends on hue. The service worker paints a progress badge over the
lower-right corner, so that corner carries nothing load-bearing.

## Publishing

Not listed yet. What a Chrome Web Store listing needs, and where this stands.

**Account.** A one-time $5 developer registration fee, up to 20 extensions on
that account. Two-step verification is mandatory on the publishing Google
account, and on the publishing API if used for CI.

**Already satisfied.** Manifest V3. No remote code — everything executes from
the package, no `eval`, no CDN, no hosted rules. No telemetry, no network calls
of any kind. A single, statable purpose: capture the visible page as one image.
A tight permission set with **no host permissions at all**:

| Permission | Justification for the listing |
|---|---|
| `activeTab` | Read the page being captured, only on an explicit click or shortcut |
| `scripting` | Inject the controller that scrolls and measures that page |
| `downloads` | Save the finished image |
| `offscreen` | Stitch frames onto a canvas; a service worker has no DOM |
| `storage` | Remember the settings on this page |
| `clipboardWrite` | Copy the finished image |
| `contextMenus` | The right-click route into these settings |

Requesting no host permissions is the single biggest thing in this extension's
favour at review. Do not add `<all_urls>` for convenience.

**Prepared.** `npm run package` builds `dist/just-screenshot-it-<version>.zip`
containing only what runs: `manifest.json`, `src/`, `icons/*.png`. Tests, docs,
SVG sources and this README stay out of the package and live here instead. Store
assets are built by `npm run store-assets` into `dist/store/`. The listing copy,
the per-permission justifications and the privacy-form answers are written out
in [`docs/store-listing.md`](docs/store-listing.md); the privacy policy is
[`PRIVACY.md`](PRIVACY.md), served over GitHub Pages.

**Still to do — these need a human with the Google account.**

- Register the developer account, pay the one-time $5 fee, and accept the
  developer agreement.
- Upload the ZIP, paste the listing copy, answer the privacy form, submit.
- Field verification on Windows and Linux. Everything so far is macOS only, and
  the clipboard behaviour in particular is measured against the macOS
  pasteboard.
- The known limits below are stated in the listing on purpose. They arrive as
  one-star reviews otherwise.

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
  part](#why-the-clipboard-is-the-awkward-part).
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
| `capture-lifecycle.test.js` | three captures in a row all succeed and each returns the worker to idle, plus the offscreen-document facts in [Why the clipboard is the awkward part](#why-the-clipboard-is-the-awkward-part) |
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

## Repository

Public at **<https://github.com/kgelster/just-screenshot-it>**, MIT licensed.

That repository is a separate copy, not a subtree of the workspace this was
built in: the earlier history carries notes about the machine it was developed
on, so it was published as one fresh commit rather than a `git subtree` split.
Sync it by mirroring the working tree, which keeps its own history:

```
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git --exclude .DS_Store \
  ./ /path/to/just-screenshot-it/
cd /path/to/just-screenshot-it && git add -A && git commit && git push
```

Its remote must be **HTTPS**. This machine's default SSH key authenticates as a
different GitHub account, so an SSH remote on a `kgelster/*` repo is refused.
Commits use the account's noreply address rather than a real one.

## Files

| Path | What it is |
|---|---|
| `manifest.json` | MV3 manifest; `activeTab`, `scripting`, `downloads`, `offscreen`, `storage`, `clipboardWrite`, `contextMenus` |
| `src/plan.js` | pure capture math: `buildCapturePlan`, `framePlacement`, `coverageGaps` |
| `src/filename.js` | pure filename construction, shared by the worker and the options preview |
| `src/settings-util.js` | pure settings helpers: unit conversion, clamping, the destination rule, preview splitting |
| `src/defaults.js` | shared option defaults and `BOUNDS` |
| `src/background.js` | service worker: injection, capture, target verification, download, badge |
| `src/capture-page.js` | injected controller with an idempotent singleton and a watchdog |
| `src/offscreen.{html,js}` | run loop, canvas stitching, encoding, clipboard |
| `src/options.{html,css,js}` | options page |
| `icons/glyph.svg`, `icons/glyph-small.svg` | toolbar mark. Line art on a transparent ground |
| `icons/tile.svg`, `icons/tile-small.svg` | the filled square, for the manifest `icons` key |
| `icons/build-icons.sh` | rasterises all four SVGs with `rsvg-convert`, then verifies size and alpha |
| `docs/codex-review-2026-08-14.md` | external review report and its resolution table |
| `docs/store-listing.md` | every field the Chrome Web Store dashboard asks for |
| `assets/promo-tile.svg` | source for the 440x280 store promo tile |
| `scripts/package.sh` | builds the store ZIP, and refuses if it finds a network API |
| `scripts/store-assets.sh`, `scripts/store-shots.mjs` | store screenshots, generated from a real capture |
| `scripts/verify-package.mjs` | loads the built ZIP in Chrome and captures with it |
| `LICENSE`, `PRIVACY.md` | MIT; the privacy policy the store listing points at |
| `tests/plan.test.js`, `tests/filename.test.js`, `tests/settings.test.js` | `node --test` |
| `tests/e2e/` | real-Chrome suite: CDP driver, shared fixtures, naming and lifecycle tests |
| `tests/fixtures/` | deterministic capture targets |
