# Codex code review, 2026-08-14

> **Status: all 14 findings fixed the same day.** Unit tests went 23 to 28, all passing.
> Findings 3, 4, and 12 have direct regression tests. Findings 1, 2, and 5 through 11 are
> lifecycle and DOM behaviour that `node --test` cannot reach; they are argued in code
> comments at each site and still need a browser pass. See "Resolution" at the bottom.

Reviewer: GPT-5 via the Codex plugin (`codex-companion task`, effort high, read-only).
Scope: every file under `src/`, plus `manifest.json`, `tests/plan.test.js`, and `README.md`.
Session: `01a0023b-fa6f-7c91-b12e-4035bad6623a` (`codex resume 01a0023b-fa6f-7c91-b12e-4035bad6623a`).

All 23 unit tests passed at review time. The reviewer reported no purely stylistic findings.

Findings 3, 4, and 12 were independently reproduced in node after the review; the transcript
of that check is in the "Verification" section at the bottom. The rest are recorded as the
reviewer stated them and are **not** yet verified against a running extension.

---

## Confirmed bugs

### 1. Critical — aborting during `prepare()` can leave the page permanently modified

`src/capture-page.js:327`, `src/capture-page.js:424`, `src/background.js:124`

Switch tabs while the lazy-load pre-pass is awaiting. `endRun()` sends an unawaited
`restore`; `restore()` clears the watchdog, but the still-running `prepare()` can resume
afterward, install capture CSS, scroll to zero, and attach an observer. Any later
restoration through the worker is rejected because `run` is already null. The page stays
altered indefinitely.

Fix: give controller operations a generation/abort token. `restore()` invalidates in-flight
work; `prepare()` re-checks that token after every await before mutating further. Make
partial preparation self-restoring in `catch`/`finally`, and await the direct restore in
`endRun()`.

### 2. Critical — a stale completion message can cancel a newer run

`src/background.js:80`, `src/background.js:275`, `src/offscreen.js:289`

Start run A, then start B before A finishes. The offscreen document replies
`{started: false}` while busy, but `startRun()` neither awaits nor checks that response.
Later A sends `fail` or `done`; neither handler validates `msg.token`, so both call
`endRun()` and terminate B. A smaller version of the same race exists immediately after
normal completion, before `busy` is cleared.

Fix: token-check `done` and `fail`; await and validate the offscreen start response;
explicitly cancel and await A before starting B, or queue B until `busy` is false.

### 3. High — vertical placement derives its scale from the rounded canvas width

`src/plan.js:125`

`framePlacement` computes one scale, `canvasWidth / crop.width`, and uses it for both axes.
`canvasWidth` is rounded, so on a tall downscaled page the vertical scale is wrong.

Reproduced: `pageHeight 61823`, crop `997x617`, dpr 1, budget 40e6. The plan is
`528x32767`, so the true vertical scale is `32767/61823 = 0.530013`, but placement uses
`528/997 = 0.529589`. The final frame ends at canvas row 32741 and the bottom 26 rows stay
white. `coverageGaps` does not catch it, because coverage is converted back through the
same wrong scale.

Fix: pass a vertical scale explicitly, ideally `canvasHeight / pageHeight`, and map every
destination boundary with it. Do not infer the Y scale from a rounded canvas width.

### 4. High — the bottom-clipping branch drops source rows in ordinary mid-page frames

`src/plan.js:136`, `src/plan.js:151`

With the same input, the ordinary frame at `scrollY 3702` starts with 617 source rows, but
destination rounding makes `dh < dhExact`, so line 153 trims `sh` to 616 even though the
frame is nowhere near the canvas bottom. That produces seams and false coverage gaps.
Reproduced: a spurious gap at `4317.57 - 4319`. Rounding `sy` and `sh` independently can
also include or omit a row when `crop.y` or the CSS-to-bitmap ratio is fractional.

Fix: only clip the source when the unrounded destination end actually exceeds
`canvasHeight`. Derive both rectangles from rounded top and bottom boundaries rather than
rounding an origin and a length separately.

### 5. High — gap retries repaint pixels that were already good

`src/offscreen.js:198`

Covered intervals `[0,800]` and `[1000,1800]` give a gap of `[800,1000]`, but the retry at
800 draws a full 800px frame through 1600 and overwrites the correct `[1000,1600]` region.
Rounding-induced gaps are worse: the retry `frameY` may not be a member of `frameYs`, so
every pinned element is hidden and the retry blanks over its valid home-frame pixels. The
loop is bounded so it cannot spin forever, but it can damage good pixels and still fail to
converge.

Fix: clip a retry to the gap's own destination interval, or track ownership per canvas row
and draw only currently unpainted spans.

### 6. High — the oversized-frame fallback runs after the oversized frame has already crossed the message boundary

`src/offscreen.js:157`, `src/background.js:299`

A PNG capture above the 64 MiB messaging limit fails in the worker's `sendResponse` before
the offscreen document can ever inspect `dataUrl.length`, so the JPEG re-capture branch is
unreachable for exactly the frames it exists to handle. README's oversized-frame defence is
not implemented.

Fix: do the size check and the JPEG re-capture inside `captureFrame()` in the worker, before
`sendResponse`.

### 7. High — the target is not verified immediately before each capture attempt

`src/background.js:151`

Verification happens before pacing, then up to 600ms of waiting follows. Quota retries also
sleep without re-verifying. If run A is replaced by B during that window, A resumes against
a mutated `run.windowId`, captures B's window, and only rejects afterward on a stale token.
That burns quota and breaks the stated pre-capture identity guarantee.

Fix: verify the token and the active tab inside every retry iteration, after all waiting and
immediately before `captureVisibleTab`, using the window ID bound to the verified token
rather than re-reading mutable global state.

### 8. High — a real service-worker restart still destroys the run

`src/background.js:13`, `src/offscreen.js:261`

If the worker restarts between frames, its `run` is null, so the offscreen document's next
RPC fails as "cancelled" — and so do its `restore` and `fail` RPCs. Restoration falls to the
page watchdog and no close is scheduled for the offscreen document. The architecture does
not actually survive the lifecycle event README claims it does.

Fix: persist enough run identity to reconstruct and validate it on worker startup, or add an
offscreen-to-worker recovery handshake. Startup recovery must also restore or close
abandoned runs.

### 9. Medium — a startup failure after injection leaves `run` and the badge stuck

`src/background.js:98`

Only `executeScript()` sits inside the `try`. If reading storage or creating the offscreen
document fails, `startRun()` rejects without calling `endRun()`, and every later attempt is
treated as replacing a supposedly active run.

Fix: wrap the whole startup sequence — injection, options, offscreen creation, dispatch — in
one `try`/`catch` that calls `endRun()` for the same token.

### 10. Medium — restore can use the page's smooth-scroll behaviour and return early

`src/capture-page.js:432`

The stylesheet forcing `scroll-behavior: auto` is removed *before* `window.scrollTo()` and
before inner-scroller restoration, so on a page with `scroll-behavior: smooth` the root can
still be animating toward the original offset after `restore()` has resolved.

Fix: restore both scroll positions while the capture stylesheet is still installed, wait for
them to settle, then remove the stylesheet.

### 11. Medium — dynamically inserted pinned descendants are never scanned

`src/capture-page.js:360`, `src/capture-page.js:264`

When page code appends a wrapper containing a sticky child, the observer queues only the
wrapper and `scanCandidates()` examines only the wrapper. The sticky child repeats in every
later frame.

Fix: for each added element, walk the node and all of its descendants and open shadow roots
with the existing walker.

### 12. Low — `maxFrames` can return one frame more than the maximum

`src/plan.js:65`

Reproduced: `pageHeight 400001`, `viewportHeight 800`, `maxFrames 500` returns **501**
frames. The loop creates 500 and the clamped final frame is appended with no further check.

Fix: check the count after appending the final frame, or check before every push.

### 13. Low — home-frame selection does not always pick the largest overlap

`src/capture-page.js:244`

The `overlap > bestOverlap + 0.5` tie-break treats a later frame whose overlap is up to
0.5 CSS px larger as tied with the earlier one, so fractional element geometry can assign
the wrong home frame.

Fix: use `overlap > bestOverlap`. Exact ties still fall to the earlier frame.

### 14. Low — the options page cannot save the documented zero settle delay

`src/options.js:20`, `src/options.html:99`

The input declares `min="0"` but `collect()` accepts only values above zero, so saving `0`
silently restores the 120ms default. It also does not enforce the 500ms floor on capture
pacing, contradicting README's claim that the floor is not tunable.

Fix: use per-field bounds and allow `settleMs >= 0`.

---

## Test coverage holes

`tests/plan.test.js:141` tests clipping only at scale 1. `tests/plan.test.js:180` and
`tests/plan.test.js:197` test downscale and crop separately. Missing:

- a composed case: downscale + fractional ratio + dpr > 1 + non-zero `crop.y` + `coveredTo`
  + bottom clipping
- a sequential-placement assertion that every canvas row is filled exactly once
- a `maxFrames` boundary case
- cases around rounded source top/bottom boundaries, and around retry clipping

Regression cases should use the concrete dimensions from findings 3 and 4.

---

## Verification

Findings 3, 4, and 12 were re-derived locally against `src/plan.js` as it stood at review
time:

```
plan 528 32767 101 frames
frame 100 (y=61206) -> dy 32676, dh 65   # ends at row 32741 of 32767: 26 blank rows
gaps [{"start":4317.57196969697,"end":4319}]
maxFrames frames: 501
```

Findings 1, 2, and 5 through 11 are argued from the code and are plausible, but were not
reproduced in a running browser.

---

## Resolution

| # | Fix | Where |
|---|---|---|
| 1 | `state.generation`, bumped by `restore()` and re-checked by `prepare()` after every await; the pre-pass takes a `cancelled` predicate; `prepare()` undoes its own partial work in `catch`; `endRun()` awaits the restore | `capture-page.js`, `background.js` |
| 2 | `done` and `fail` drop messages whose token is not the current run; `startRun` awaits the offscreen start reply and retries for up to 5s while the previous loop unwinds | `background.js` |
| 3 | `framePlacement` takes `canvasScaleY`; the plan reports the `pageHeight` its canvas was sized for | `plan.js`, `offscreen.js` |
| 4 | Source and destination are both derived from rounded CSS-px boundaries; the proportional source trim is gone | `plan.js` |
| 5 | `limitTo` bounds a retry to its gap; retries pass the planned frame that owns the band so the pinned policy still matches | `plan.js`, `offscreen.js` |
| 6 | Size check and JPEG re-capture moved into `captureFrame()` in the worker | `background.js`, `offscreen.js` |
| 7 | Pacing sleep moved inside the retry loop, before `verifyTarget`; `verifyTarget` re-checks the token after its own await and returns the verified windowId | `background.js` |
| 8 | The run record is mirrored into `chrome.storage.session` and re-adopted by token when an RPC reaches a restarted worker | `background.js` |
| 9 | The whole startup sequence is in one `try`/`catch` that calls `endRun` for the same token | `background.js` |
| 10 | Scroll positions are restored while the capture stylesheet is still installed, then two frames pass before it is removed | `capture-page.js` |
| 11 | Added nodes are expanded through the existing `walk()` before scanning | `capture-page.js` |
| 12 | The frame count is re-checked after the clamped final frame is appended | `plan.js` |
| 13 | `overlap > bestOverlap`, no slack | `capture-page.js` |
| 14 | Per-field `BOUNDS` replace the single "> 0" rule; `settleMs` accepts 0, `captureIntervalMs` is clamped to its 500ms floor | `options.js` |
| 15 | Five new tests: `maxFrames` boundary, `plan.pageHeight`, `limitTo` clipping, a full 101-frame downscale walk asserting frames abut and the canvas fills to its last row, and a dpr-2 walk with a non-zero `crop.y` | `tests/plan.test.js` |

Still unverified in a browser: 1, 2, 5, 6, 7, 8, 9, 10, 11.
