# Privacy Policy — Just Screenshot It

**Last updated: 2026-08-15**

Just Screenshot It collects nothing, transmits nothing, and contacts no server.

## What the extension does with your data

When you click the toolbar button or press the shortcut, the extension
photographs the current tab, stitches those frames into one image, saves that
image to your Downloads folder, and optionally puts it on your clipboard.

All of that happens locally, inside your browser, on your computer.

## What is stored

Your settings — filename template, image format, quality, and the capture
options — are stored with `chrome.storage.local`, which keeps them on this
device only. Nothing is synced to a Google account.

The extension also records the filename of the most recent capture, so the
options page can tell you if Chrome saved it under a different name than the one
requested. That single record is overwritten by the next capture.

Uninstalling the extension deletes all of it.

## What is never collected

- No personal or financial information
- No authentication information, passwords, or credentials
- No browsing history, page contents, or URLs beyond the tab you explicitly
  capture — and even that never leaves your machine
- No analytics, telemetry, crash reporting, or usage statistics
- No advertising or tracking identifiers

## Network activity

The extension makes no network requests. It has no host permissions, contains
no remote code, loads no third-party scripts, fonts, or resources, and has no
backend of any kind. You can verify this: the source is at
<https://github.com/kgelster/just-screenshot-it> and the entire package is
plain, unminified JavaScript.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the tab you are capturing, granted only by your click or shortcut |
| `scripting` | Inject the controller that scrolls and measures that page |
| `downloads` | Save the finished image to your Downloads folder |
| `offscreen` | Stitch frames onto a canvas; a service worker has no DOM |
| `storage` | Remember your settings on this device |
| `clipboardWrite` | Copy the finished image, if you enable that option |
| `contextMenus` | The right-click route into the settings page |

There are deliberately **no host permissions**. The extension cannot read any
site until you ask it to capture one.

## Data sharing

There is nothing to share. No data is sold, transferred, or disclosed to anyone,
because no data ever leaves your device.

## Changes

Any change to this policy will be committed to the repository above, and the
date at the top will change with it.

## Contact

Open an issue at <https://github.com/kgelster/just-screenshot-it/issues>.
