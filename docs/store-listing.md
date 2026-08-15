# Chrome Web Store listing

Everything the dashboard asks for, written out so it is pasted rather than
improvised at 11pm. Field names match the Developer Dashboard as of 2026-08.

Build the upload and the assets first:

```
npm run package        # dist/just-screenshot-it-<version>.zip
npm run store-assets   # dist/store/*.png
```

---

## Store listing tab

**Item name** (45 chars shown, 75 max)

```
Just Screenshot It
```

**Summary** (132 max — this is the line under the name in search results)

```
Capture the entire scrollable page as one image. One keystroke, no account, no telemetry, no host permissions.
```

**Description** (16,000 max)

```
Just Screenshot It captures the whole scrollable page as a single image, saves
it to your Downloads folder, and puts it on your clipboard. One keystroke or one
click on the toolbar button. There is no popup to get through and no account to
create.

WHAT MAKES IT DIFFERENT

• No host permissions. The extension cannot read any site until you explicitly
  ask it to capture one. Most full-page screenshot extensions request access to
  every website you visit; this one never does.
• No network access of any kind. No analytics, no telemetry, no crash
  reporting, no backend. The extension makes zero requests.
• Open source, MIT licensed, and unminified. Every claim above is checkable:
  https://github.com/kgelster/just-screenshot-it
• No debugger banner. It does not attach to the DevTools protocol, so Chrome
  never shows the yellow "is debugging this browser" bar.

STICKY HEADERS APPEAR ONCE

The hard part of a full-page screenshot is not scrolling, it is everything that
follows you down the page. Sticky navigation bars, cookie banners, floating
chat widgets and sticky footers get photographed in every frame and stitched
into a stack of duplicates.

This extension decides what is pinned by measuring, not by reading CSS: is this
element displaced from its natural position in the document right now? Each
pinned element then gets exactly one frame it is allowed to appear in — the one
its natural position belongs to — and is hidden everywhere else. A sticky footer
on a short page is not deleted, and a full-height sticky sidebar is not drawn
twice.

Scroll snapping, scroll anchoring and lazy-loaded images are all handled before
the first frame is taken, and any row that ends up unpainted is detected and
re-captured.

CONTROL OVER THE FILENAME

Captures are named from a template with a live preview, so they land somewhere
you can find them again:

  screenshots/{host}/{yyyy}-{mm}-{dd}-{hh}{mi}{ss}-{title}.{ext}

Use / to build folders inside Downloads. Tokens cover the host, page title, URL
path, date, time and image dimensions. Three presets are one click away.

ALSO

• PNG or JPEG, with a quality control
• Copy to clipboard, save to Downloads, or both
• A lazy-load pre-pass that scrolls the page first so images are loaded
• An option to remove full-screen overlays before capturing
• A memory budget, so very tall pages downscale predictably instead of failing
• Progress on the toolbar badge, and a readable reason when a capture aborts

KNOWN LIMITS, STATED UP FRONT

• Chrome blocks extensions on chrome:// pages, the Web Store, and other
  extensions' pages. Nothing can capture those.
• file:// URLs need "Allow access to file URLs" turned on for the extension.
• Cross-origin iframes are captured as they appear; the extension cannot scroll
  inside them.
• Infinite feeds capture the page as tall as it is when measured, not forever.
• Horizontal overflow is cropped to the visible column. The image is one
  viewport wide by design.
• Clipboard copies paste into rich-text targets such as Slack, Gmail and Google
  Docs. They do not paste into pixel editors like Preview or Photoshop — Chrome
  only exposes an HTML flavour to an extension. Use the saved file for those.

Written from scratch after GoFullPage went closed-source and was pulled from
the Web Store. No GoFullPage code was copied or consulted.
```

**Category** — Productivity → Workflow & Planning
**Language** — English (United States)

**Graphic assets**

| Field | File |
|---|---|
| Store icon, 128×128 | `dist/store/store-icon-128.png` |
| Screenshot 1, 1280×800 | `dist/store/screenshot-1-what-it-does.png` |
| Screenshot 2, 1280×800 | `dist/store/screenshot-2-settings.png` |
| Small promo tile, 440×280 | `dist/store/promo-tile-440x280.png` |
| Marquee, 1400×560 | not made; optional, and only used if Google features the item |

**Additional fields**

| Field | Value |
|---|---|
| Homepage URL | `https://github.com/kgelster/just-screenshot-it` |
| Support URL | `https://github.com/kgelster/just-screenshot-it/issues` |
| Mature content | No |

---

## Privacy tab

**Single purpose description**

```
Capture the currently open web page, including the parts below the fold, as a
single image file and save it to the user's computer.
```

**Permission justifications** — reviewers read every one of these. Each says
what the permission is used for and, where it matters, what is not done with it.

| Permission | Justification |
|---|---|
| `activeTab` | Reads the page being captured. It is granted only when the user clicks the toolbar button or presses the keyboard shortcut, and only for that tab. This is used instead of host permissions so that the extension has no access to any site until the user explicitly asks for a capture. |
| `scripting` | Injects the controller that measures the page, scrolls it one viewport at a time, hides elements that are pinned to the viewport so they are not duplicated in every frame, and then restores the page to how it was. It runs only in the tab being captured, only after the user starts a capture. |
| `downloads` | Saves the finished image to the user's Downloads folder under the filename template they configured. The extension also reads back the saved path of its own download to warn the user when another installed extension has renamed it. |
| `offscreen` | Stitches the captured frames onto a canvas and encodes the result. A Manifest V3 service worker has no DOM and cannot do this, and it can be terminated mid-capture, which would leave the page scrolled with its scrollbars hidden. The offscreen document also performs the clipboard copy. |
| `storage` | Stores the user's settings — filename template, image format, quality and capture options — locally on their device with chrome.storage.local. Nothing is synced or transmitted. |
| `clipboardWrite` | Places the finished image on the clipboard, when the user has that option enabled. |
| `contextMenus` | Adds a single "Screenshot settings" item to the right-click menu of the extension's own toolbar button. Clicking the button captures, so there is no popup to put a settings link in; this is the only route to the options page other than chrome://extensions. |

**Remote code** — No, I am not using remote code. Everything executes from
files inside the package. There is no `eval`, no `new Function`, no
`importScripts`, no CDN and no hosted configuration. `npm run package` fails the
build if any of those appear.

**Data usage** — tick nothing. The extension collects none of the listed
categories: no personally identifiable information, health information,
financial information, authentication information, personal communications,
location, web history, user activity, or website content leaves the device. The
captured image is written to the user's own disk and never transmitted.

Then certify all three:

- I do not sell or transfer user data to third parties, outside of the approved
  use cases
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes

**Privacy policy URL**

```
https://github.com/kgelster/just-screenshot-it/blob/main/PRIVACY.md
```

---

## Distribution tab

- Visibility: **Public**
- Distribution: **All regions**
- Pricing: **Free**

---

## Before submitting

- [ ] `npm test` and `npm run test:e2e` both green
- [ ] `npm run package` clean, and the ZIP loads unpacked from a fresh unzip
- [ ] Version in `manifest.json` is higher than the published one
- [ ] The repository is public, so the Homepage and Privacy URLs resolve
- [ ] Verified on Windows or Linux, or the listing does not claim them

## What only the account holder can do

Registering the developer account, paying the one-time $5 fee, accepting the
developer agreement, uploading the package and pressing submit all require
signing in to the Google account that will own the item. Review typically takes
a few days; items with no host permissions and no remote code are the fast case.
