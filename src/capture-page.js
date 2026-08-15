// Injected controller. Classic script (executeScript files are not modules).
//
// Owns everything that has to happen inside the page: the lazy-load pre-pass,
// the capture CSS, scrolling and settling, deciding which pinned elements to
// hide for a given frame, and putting all of it back afterwards.
//
// It is injected fresh on every run, so it must be idempotent — a second
// injection must not install a second message listener.

(() => {
  const KEY = '__fullpageShotController';
  if (window[KEY]) {
    window[KEY].touch();
    return;
  }

  const STYLE_ID = '__fullpage-shot-capture-css';
  const WATCHDOG_MS = 30000;
  const PINNED_EPSILON = 2; // CSS px of slack before we call something pinned

  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = {
    scroller: null, // null = root scroller
    crop: null,
    styleEl: null,
    hidden: new Map(), // el -> prior `style` attribute (or null if it had none)
    candidates: [], // {el, naturalDocTop, height, forceStrip}
    known: new Set(),
    eagered: [], // <img> whose loading attribute we changed
    origScroll: { root: [0, 0], el: null },
    observer: null,
    pending: [], // elements added mid-run, awaiting evaluation
    overlayPolicy: 'keep',
    watchdog: null,
    // Bumped by every restore. `prepare()` captures the value it started with
    // and re-checks it after each await: a restore that arrives mid-prepare
    // would otherwise clean up, then watch the still-running prepare install
    // capture CSS and scroll to zero behind it, with nobody left to undo that.
    generation: 0,
  };

  // ---------------------------------------------------------------- geometry

  const rootScrollY = () => window.scrollY;
  const scrollTopOf = () => (state.scroller ? state.scroller.scrollTop : rootScrollY());

  function scrollToY(y) {
    if (state.scroller) state.scroller.scrollTop = y;
    else window.scrollTo(0, y);
  }

  function rootPageHeight() {
    const de = document.documentElement;
    return Math.max(
      de.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      de.clientHeight,
    );
  }

  const pageHeightOf = () =>
    state.scroller ? state.scroller.scrollHeight : rootPageHeight();

  function rootCrop() {
    const de = document.documentElement;
    return { x: 0, y: 0, width: de.clientWidth, height: de.clientHeight };
  }

  function contentBoxCrop(el) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    return {
      x: rect.left + bl,
      y: rect.top + bt,
      width: el.clientWidth,
      height: el.clientHeight,
    };
  }

  // -------------------------------------------------------- element walking

  function* walk(root) {
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = it.currentNode;
    while (n) {
      if (n.nodeType === 1) {
        yield n;
        if (n.shadowRoot) yield* walk(n.shadowRoot); // open shadow roots only
      }
      n = it.nextNode();
    }
  }

  function allElements() {
    const out = [];
    for (const el of walk(document.documentElement)) out.push(el);
    return out;
  }

  // ------------------------------------------------------------ inner scroll

  function findInnerScroller() {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const vh = de.clientHeight;
    let best = null;
    for (const el of allElements()) {
      if (el === de || el === document.body) continue;
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      const cs = getComputedStyle(el);
      if (!/^(auto|scroll|overlay)$/.test(cs.overflowY)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) continue;
      const area = rect.width * rect.height;
      if (!best || area > best.area) best = { el, rect, area };
    }
    if (!best) return null;
    const fills =
      best.rect.width >= vw * 0.9 &&
      best.rect.height >= vh * 0.85 &&
      best.rect.top <= vh * 0.15 &&
      best.rect.left <= vw * 0.1;
    return { el: best.el, rect: best.rect, fills };
  }

  // ------------------------------------------------------------ capture CSS

  const CAPTURE_CSS = `
    html, body { scroll-behavior: auto !important; }
    *, *::before, *::after {
      scroll-behavior: auto !important;
      scroll-snap-type: none !important;
      scroll-snap-align: none !important;
      overflow-anchor: none !important;
      animation-play-state: paused !important;
      transition: none !important;
      caret-color: transparent !important;
    }
    html { scrollbar-width: none !important; }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  `;

  function installCss() {
    if (state.styleEl) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CAPTURE_CSS;
    (document.head || document.documentElement).appendChild(el);
    state.styleEl = el;
  }

  // ------------------------------------------------------- pinned detection

  /**
   * A sticky element is *already pinned* at scroll 0 when it sticks to the
   * bottom, so its rect there is not its natural position — reading it that
   * way parks a sticky footer in the middle of the page. Sticky elements stay
   * in normal flow, so dropping `position` to static for one synchronous
   * measurement moves only this element and reveals its true flow offset.
   * A fixed element has no flow position at all; its scroll-0 viewport
   * position is the right place for it to appear once.
   */
  function naturalTopOf(el, position, rect) {
    if (position !== 'sticky') return rect.top + scrollTopOf();
    const prev = el.getAttribute('style');
    el.style.setProperty('position', 'static', 'important');
    const flowTop = el.getBoundingClientRect().top + scrollTopOf();
    if (prev === null) el.removeAttribute('style');
    else el.setAttribute('style', prev);
    return flowTop;
  }

  function candidateFor(el) {
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      return null;
    }
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;

    const de = document.documentElement;
    const coversViewport =
      rect.width >= de.clientWidth * 0.85 && rect.height >= de.clientHeight * 0.85;

    return {
      el,
      naturalDocTop: naturalTopOf(el, cs.position, rect),
      height: rect.height,
      forceStrip: state.overlayPolicy === 'strip' && coversViewport && cs.position === 'fixed',
    };
  }

  function scanCandidates(elements) {
    for (const el of elements) {
      if (state.known.has(el)) continue;
      state.known.add(el);
      const c = candidateFor(el);
      if (c) state.candidates.push(c);
    }
  }

  function setHidden(el, hide) {
    const had = state.hidden.has(el);
    if (hide) {
      if (had) return;
      state.hidden.set(el, el.getAttribute('style'));
      // opacity preserves layout exactly; display/visibility do not, and
      // demoting `position: sticky` would change containing blocks and z-order.
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
    } else {
      if (!had) return;
      const prev = state.hidden.get(el);
      if (prev === null) el.removeAttribute('style');
      else el.setAttribute('style', prev);
      state.hidden.delete(el);
    }
  }

  /**
   * The one frame a pinned element is allowed to appear in: the frame whose
   * band overlaps the element's *natural* band the most. Ties go to the
   * earliest frame.
   *
   * Mere overlap is not enough. A sticky rail with `top: 57px` and
   * `height: calc(100dvh - 57px)` has a natural band exactly one viewport tall,
   * so on a two-frame page it overlaps the second frame by a few dozen pixels —
   * and an "overlaps this frame?" test then re-draws the whole pinned rail a
   * second time. Picking the single best frame is what makes it appear once.
   *
   * This is deliberately not shared with `plan.js`: `executeScript` files are
   * classic scripts and cannot import. The fixtures are its test.
   */
  function homeFrameFor(c, frames, viewportHeight) {
    if (!frames || !frames.length) return 0;
    let best = frames[0];
    let bestOverlap = -Infinity;
    for (const fy of frames) {
      const overlap =
        Math.min(c.naturalDocTop + c.height, fy + viewportHeight) -
        Math.max(c.naturalDocTop, fy);
      // Strictly greater, so an exact tie keeps the earlier frame. Any slack
      // here hands the frame to whichever candidate the loop saw first, even
      // when a later one genuinely overlaps more.
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = fy;
      }
    }
    return best;
  }

  /**
   * An element is hidden for this frame when it is *currently displaced from
   * its natural document position* (i.e. it is actually pinned right now) and
   * this is not its home frame. That covers sticky headers, sticky footers, and
   * fixed bars — and it leaves `position: fixed` inside a transformed ancestor
   * alone, because such an element scrolls with the page and is never
   * displaced.
   *
   * The home-frame exemption matters for elements that are pinned in *every*
   * frame — a `bottom: 0` sticky footer on a single-frame page is displaced at
   * scroll 0, and hiding on displacement alone would delete it outright.
   */
  function applyPinnedPolicy(frameY, frames, viewportHeight) {
    if (state.pending.length) {
      // The observer reports the node that was inserted, not its subtree. A
      // page that appends a wrapper containing a sticky child would otherwise
      // hand us only the wrapper, and the child would repeat in every frame.
      const batch = state.pending.splice(0, state.pending.length);
      const expanded = [];
      for (const node of batch) {
        if (!node.isConnected) continue;
        for (const el of walk(node)) expanded.push(el);
      }
      scanCandidates(expanded);
    }
    const top = scrollTopOf();
    for (const c of state.candidates) {
      if (!c.el.isConnected) continue;
      if (c.forceStrip) {
        setHidden(c.el, true);
        continue;
      }
      const rect = c.el.getBoundingClientRect();
      const currentDocTop = rect.top + top;
      const displaced = Math.abs(currentDocTop - c.naturalDocTop) > PINNED_EPSILON;
      const atHome = frameY === homeFrameFor(c, frames, viewportHeight);
      setHidden(c.el, displaced && !atHome);
    }
  }

  // ------------------------------------------------------------- pre-pass

  async function lazyLoadPrePass(viewportHeight, cancelled) {
    for (const img of document.querySelectorAll('img[loading="lazy"]')) {
      state.eagered.push(img);
      img.loading = 'eager';
    }
    const start = Date.now();
    const step = Math.max(200, viewportHeight);
    const initial = pageHeightOf();
    // Re-read the height every iteration: the whole point is that the page
    // grows while we walk it. Bounded by wall clock and by a runaway multiple
    // of the starting height, so an infinite feed cannot hold the run open.
    for (let y = 0; Date.now() - start < 5000; y += step) {
      if (cancelled()) return;
      const h = pageHeightOf();
      if (y > h || h > initial * 8) break;
      scrollToY(y);
      await raf();
      await sleep(60);
    }
    if (cancelled()) return;
    scrollToY(0);
    await raf();
  }

  async function waitForStableHeight(timeoutMs = 2000) {
    let last = -1;
    let stable = 0;
    const start = Date.now();
    while (stable < 4 && Date.now() - start < timeoutMs) {
      await raf();
      const h = pageHeightOf();
      if (h === last) stable += 1;
      else {
        stable = 0;
        last = h;
      }
    }
    return pageHeightOf();
  }

  // --------------------------------------------------------------- methods

  const methods = {
    async prepare({ prePass = true, overlayPolicy = 'keep' } = {}) {
      const gen = state.generation;
      const cancelled = () => state.generation !== gen;
      const bail = () => {
        if (cancelled()) throw new Error('capture was cancelled');
      };

      state.overlayPolicy = overlayPolicy;
      state.origScroll.root = [window.scrollX, window.scrollY];

      try {
        // Pick the scroller before anything else so the pre-pass scrolls the
        // right thing.
        const de = document.documentElement;
        if (rootPageHeight() > de.clientHeight + 1) {
          state.scroller = null;
        } else {
          const inner = findInnerScroller();
          if (inner && inner.fills) {
            state.scroller = inner.el;
            state.origScroll.el = inner.el.scrollTop;
          } else if (inner) {
            return {
              mode: 'refuse',
              reason:
                'This page scrolls inside a panel that does not fill the window. ' +
                'fullpage-shot v1 captures the root scroller only.',
            };
          } else {
            state.scroller = null; // short page, one frame
          }
        }

        if (prePass) await lazyLoadPrePass(de.clientHeight, cancelled);
        bail();

        // CSS goes on *before* measuring: hiding scrollbars changes layout.
        installCss();
        scrollToY(0);
        await waitForStableHeight();
        bail();

        state.observer = new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.addedNodes) if (n.nodeType === 1) state.pending.push(n);
          }
        });
        state.observer.observe(document.documentElement, { childList: true, subtree: true });

        scanCandidates(allElements());
        return { mode: 'ok' };
      } catch (e) {
        // Whatever was installed before the failure is ours to undo. Nobody
        // else will: the worker has already forgotten this run.
        await restoreState();
        throw e;
      }
    },

    async measure() {
      const de = document.documentElement;
      const crop = state.scroller ? contentBoxCrop(state.scroller) : rootCrop();
      state.crop = crop;
      return {
        mode: state.scroller ? 'element' : 'root',
        pageHeight: pageHeightOf(),
        viewportWidth: window.innerWidth, // reference for the CSS->bitmap ratio
        viewportHeight: window.innerHeight,
        crop,
        dpr: window.devicePixelRatio || 1,
        title: document.title || '',
        url: location.href,
        clientWidth: de.clientWidth,
      };
    },

    async scrollTo({ y, settleMs = 120 }) {
      scrollToY(y);
      // Two consecutive identical readings across animation frames. Scroll
      // snap and smooth scrolling both settle asynchronously.
      let last = Number.NaN;
      let stable = 0;
      for (let i = 0; i < 60 && stable < 2; i += 1) {
        await raf();
        const cur = scrollTopOf();
        if (cur === last) stable += 1;
        else {
          stable = 0;
          last = cur;
        }
      }
      if (settleMs > 0) await sleep(settleMs);
      return { actualScrollY: Math.max(0, scrollTopOf()), pageHeight: pageHeightOf() };
    },

    // The page console is the only surface a capture can report to, since the
    // service worker's console lives behind chrome://extensions.
    async log({ message }) {
      console.log('[fullpage-shot]', message);
      return { ok: true };
    },

    // `frameY` is the scroll offset that was *requested* for this frame, not
    // where the page actually landed — it has to match an entry in `frames`
    // exactly for the home-frame test to fire.
    async beforeFrame({ frameY, frames, viewportHeight }) {
      applyPinnedPolicy(frameY, frames, viewportHeight);
      await raf();
      await raf();
      return { ok: true };
    },

    // Bump the generation first, so any `prepare()` still in flight sees that
    // it has been superseded and undoes its own work instead of continuing to
    // mutate a page this call is putting back.
    async restore() {
      state.generation += 1;
      return restoreState();
    },
  };

  async function restoreState() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    for (const el of [...state.hidden.keys()]) setHidden(el, false);
    for (const img of state.eagered) img.loading = 'lazy';
    state.eagered = [];

    // Scroll back while the capture stylesheet is still installed. It carries
    // `scroll-behavior: auto !important`; removing it first lets a page with
    // `scroll-behavior: smooth` animate toward the old offset long after this
    // call has resolved.
    if (state.scroller && state.origScroll.el != null) {
      state.scroller.scrollTop = state.origScroll.el;
    }
    window.scrollTo(state.origScroll.root[0], state.origScroll.root[1]);
    await raf();
    await raf();

    if (state.styleEl) {
      state.styleEl.remove();
      state.styleEl = null;
    }
    state.scroller = null;
    state.origScroll.el = null;
    state.candidates = [];
    state.known = new Set();
    state.pending = [];
    clearTimeout(state.watchdog);
    state.watchdog = null;
    return { ok: true };
  }

  // --------------------------------------------------------------- plumbing

  function touch() {
    clearTimeout(state.watchdog);
    // If coordination goes silent — worker terminated, offscreen document
    // closed, tab switched away — put the page back rather than stranding it
    // with a hidden header and no scrollbars.
    state.watchdog = setTimeout(() => {
      methods.restore().catch(() => {});
    }, WATCHDOG_MS);
  }

  window[KEY] = { touch, methods };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'page') return undefined;
    const fn = methods[msg.method];
    if (!fn) {
      sendResponse({ error: `unknown method ${msg.method}` });
      return undefined;
    }
    touch();
    Promise.resolve()
      .then(() => fn(msg.args || {}))
      .then(
        (value) => sendResponse({ value }),
        (e) => sendResponse({ error: String((e && e.message) || e) }),
      );
    return true;
  });

  touch();
})();
