import { DEFAULTS, BOUNDS } from './defaults.js';
import { buildFilename, resolveTokens, TOKEN_GROUPS } from './filename.js';
import {
  clampSetting,
  isDegenerateTemplate,
  mpToPixels,
  pixelsToMp,
  splitPreview,
} from './settings-util.js';

// A stand-in page for the preview. Deliberately awkward: a title with
// punctuation and an accent, and a path deep enough to show what {path} does.
const SAMPLE = {
  // example.com is reserved (RFC 2606), which keeps `npm run package`'s
  // "no absolute URLs in the package" check honest about the one string that
  // legitimately looks like one.
  url: 'https://www.example.com/collections/all/products/wide-brim-hat',
  title: 'Wide-Brim Hat — Sale | Example Café',
  width: 1440,
  height: 8213,
};

const PRESETS = [
  {
    label: 'By site',
    template: 'screenshots/{host}/{yyyy}-{mm}-{dd}-{hh}{mi}{ss}-{title}.{ext}',
  },
  {
    label: 'By date',
    template: 'screenshots/{yyyy}-{mm}-{dd}/{host}-{title}.{ext}',
  },
  {
    label: 'Flat',
    template: '{host}-{yyyy}{mm}{dd}-{hh}{mi}{ss}.{ext}',
  },
];

const FILENAME_DEBOUNCE_MS = 400;

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  shortcut: $('shortcut'),
  template: $('filenameTemplate'),
  presets: $('presets'),
  chips: $('tokenChips'),
  preview: $('filenamePreview'),
  filenameWarn: $('filenameWarn'),
  destinationWarn: $('destinationWarn'),
  lastCapture: $('lastCapture'),
  jpegQuality: $('jpegQuality'),
  jpegQualityValue: $('jpegQualityValue'),
  pixelBudgetDesc: $('pixelBudgetDesc'),
  reset: $('reset'),
};

/** Last values known to be in storage. Also what an invalid edit reverts to. */
let current = { ...DEFAULTS };

// ------------------------------------------------------------------ writing

/**
 * Writes are ordered by a monotonic revision, and only the newest one is
 * allowed to speak. Without that, a slow successful write can land after a
 * fast failed one and replace "Not saved" with "Saved" while the value on
 * disk is the older of the two.
 */
let revision = 0;
let announced = 0;

async function commit(patch) {
  current = { ...current, ...patch };
  const rev = ++revision;
  try {
    await chrome.storage.local.set(patch);
    if (rev > announced) {
      announced = rev;
      setStatus('Saved');
    }
  } catch (err) {
    if (rev > announced) {
      announced = rev;
      setStatus(`Not saved: ${err?.message || 'storage write failed'}`, true);
    }
  }
}

let statusTimer = null;

function setStatus(text, isError = false) {
  clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle('is-error', isError);
  // A write failure is a state, not an event; it stays until the next write.
  if (!isError) statusTimer = setTimeout(() => { els.status.textContent = ''; }, 2200);
}

// ------------------------------------------------------------------ reading

const formatInputs = () => [...document.querySelectorAll('input[name="format"]')];
const selectedFormat = () => formatInputs().find((r) => r.checked)?.value || DEFAULTS.format;

/** Apply BOUNDS to the markup so the numbers cannot drift from the clamp. */
function applyBounds() {
  for (const [key, b] of Object.entries(BOUNDS)) {
    const el = $(key);
    if (!el) continue;
    const toUi = key === 'pixelBudget' ? pixelsToMp : (n) => n;
    el.min = String(toUi(b.min));
    el.max = String(toUi(b.max));
    el.step = String(toUi(b.step));
  }
}

function renderNumber(key, value) {
  const el = $(key);
  if (!el) return;
  el.value = String(key === 'pixelBudget' ? pixelsToMp(value) : value);
  el.classList.remove('is-invalid');
}

function render(values) {
  els.template.value = values.filenameTemplate;
  for (const radio of formatInputs()) radio.checked = radio.value === values.format;
  for (const key of ['download', 'copyToClipboard', 'prePass']) $(key).checked = Boolean(values[key]);
  $('overlayPolicy').value = values.overlayPolicy;
  for (const key of Object.keys(BOUNDS)) renderNumber(key, values[key]);

  renderQualityReadout();
  renderBudgetHint();
  renderPresets();
  renderPreview();
  els.destinationWarn.hidden = true;
}

// -------------------------------------------------------------- numeric rows

/**
 * Blur or change on a number field.
 *
 * Unusable input reverts to the stored value rather than substituting
 * DEFAULTS[key], which is what the old `collect()` did — clearing a field for
 * a moment quietly threw away a custom setting. Out of range still clamps, and
 * the field is rewritten so the clamp is visible.
 */
function applyNumber(key) {
  const el = $(key);
  const text = el.value.trim();
  // Only the budget is displayed in different units than it is stored in.
  const stored = text !== '' && key === 'pixelBudget' ? mpToPixels(text) : text;
  const value = clampSetting(key, stored);

  if (value === null) {
    renderNumber(key, current[key]);
    setStatus(`Kept the previous value for ${labelFor(key)}`);
  } else {
    renderNumber(key, value);
    if (value !== current[key]) commit({ [key]: value });
  }

  if (key === 'pixelBudget') renderBudgetHint();
}

const labelFor = (key) =>
  document.querySelector(`label[for="${key}"]`)?.textContent.trim().toLowerCase() || key;

function renderQualityReadout() {
  els.jpegQualityValue.textContent = `${els.jpegQuality.value}%`;
}

/**
 * The budget is an area, so what it costs you is a page height, and that
 * height falls with the square of the device pixel ratio: the canvas is
 * `(vw·dpr) × (ph·dpr)`. Stated for the common case rather than left as a
 * bare eight-digit number.
 */
function renderBudgetHint() {
  const px = mpToPixels($('pixelBudget').value);
  const height = Math.round(px / (1440 * 2 * 2) / 100) * 100;
  const base = 'Lower values use less memory but downscale tall pages sooner.';
  els.pixelBudgetDesc.textContent = Number.isFinite(height) && height > 0
    ? `${base} A 1440px-wide page downscales past about ${height.toLocaleString()}px tall on a 2× display.`
    : base;
}

// ------------------------------------------------------------------ filename

let filenameTimer = null;

function scheduleFilenameWrite() {
  clearTimeout(filenameTimer);
  filenameTimer = setTimeout(flushFilename, FILENAME_DEBOUNCE_MS);
}

/**
 * Cancels the pending debounce before writing, so an immediate flush on blur
 * or Enter cannot be followed by a stale delayed write of the same field.
 */
function flushFilename() {
  clearTimeout(filenameTimer);
  filenameTimer = null;
  const value = els.template.value.trim();
  if (!value) return; // handled on blur, by reverting
  if (value !== current.filenameTemplate) commit({ filenameTemplate: value });
}

function renderPreview() {
  const template = els.template.value.trim();
  const ext = selectedFormat() === 'jpeg' ? 'jpg' : 'png';
  const built = buildFilename(template, { ...SAMPLE, ext });
  const { dirs, stem, ext: suffix } = splitPreview(built);

  els.preview.textContent = '';
  const dir = document.createElement('span');
  dir.className = 'preview__dir';
  dir.textContent = ['Downloads', ...dirs].join('/') + '/';

  const name = document.createElement('span');
  name.className = 'preview__name';
  name.textContent = stem;

  const tail = document.createElement('span');
  tail.className = 'preview__ext';
  tail.textContent = suffix ? `.${suffix}` : '';

  els.preview.append(dir, name, tail);

  const degenerate = isDegenerateTemplate(template);
  els.filenameWarn.hidden = !degenerate;
  if (degenerate) {
    els.filenameWarn.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'notice__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '!';
    els.filenameWarn.append(
      icon,
      document.createTextNode(
        template
          ? 'This template has no tokens, so every capture gets the same name.'
          : 'A filename is required. Leaving this empty keeps the previous one.',
      ),
    );
  }
  renderPresets();
}

function renderPresets() {
  const value = els.template.value.trim();
  for (const btn of els.presets.querySelectorAll('.preset')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.template === value));
  }
}

function buildPresets() {
  for (const preset of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset';
    btn.textContent = preset.label;
    btn.dataset.template = preset.template;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      els.template.value = preset.template;
      renderPreview();
      flushFilename();
    });
    els.presets.append(btn);
  }
}

/**
 * Token chips, built from TOKEN_GROUPS and labelled with the value each one
 * resolves to for SAMPLE. The name on the button is a sentence
 * ("Insert page title") rather than the raw brace syntax.
 */
function buildChips() {
  const values = resolveTokens({ ...SAMPLE, ext: 'png' });

  for (const group of TOKEN_GROUPS) {
    const wrap = document.createElement('div');
    wrap.className = 'chipgroup';

    const heading = document.createElement('span');
    heading.className = 'chipgroup__label';
    heading.textContent = group.label;
    wrap.append(heading);

    for (const token of group.tokens) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.setAttribute('aria-label', `Insert ${token.label}`);

      const key = document.createElement('span');
      key.className = 'chip__key';
      key.textContent = `{${token.key}}`;

      const val = document.createElement('span');
      val.className = 'chip__val';
      val.textContent = values[token.key] || '—';

      btn.append(key, val);
      btn.addEventListener('click', () => insertToken(token.key));
      wrap.append(btn);
    }
    els.chips.append(wrap);
  }
}

function insertToken(key) {
  const el = els.template;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const text = `{${key}}`;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const caret = start + text.length;
  el.focus();
  el.setSelectionRange(caret, caret);
  renderPreview();
  scheduleFilenameWrite();
}

// ----------------------------------------------------------- last capture

/**
 * Report where the last capture actually landed.
 *
 * `requested` is what the filename template produced; `saved` is the absolute
 * path Chrome reports afterwards. They can differ without any error being
 * raised, and until this line existed the only place that showed up was the
 * service worker console.
 */
async function renderLastCapture() {
  let record;
  try {
    ({ lastCapture: record } = await chrome.storage.local.get('lastCapture'));
  } catch {
    /* nothing recorded */
  }
  if (!record || !record.requested) {
    els.lastCapture.hidden = true;
    return;
  }

  const when = new Date(record.at).toLocaleString();
  const saved = record.saved || '';
  const matched = record.state === 'complete' && saved.endsWith(record.requested);

  els.lastCapture.hidden = false;
  els.lastCapture.classList.toggle('is-bad', !matched);
  els.lastCapture.textContent = '';

  const path = document.createElement('code');
  path.textContent = saved || record.requested;

  if (matched) {
    els.lastCapture.append(document.createTextNode(`Last capture, ${when}: `), path);
  } else {
    const wanted = document.createElement('code');
    wanted.textContent = record.requested;
    els.lastCapture.append(
      document.createTextNode(`Last capture, ${when}: asked for `),
      wanted,
      document.createTextNode(', Chrome saved '),
      path,
      // Actionable, because the remedy is known and odd enough that nobody
      // would guess it: Chrome settles competing filename suggestions by
      // install recency, so making this the newest install wins the argument.
      document.createTextNode(
        '. Another download manager extension is renaming it. Chrome gives the' +
          ' most recently installed extension the last word, so removing and' +
          ' re-adding Just Screenshot It puts it back in front.',
      ),
    );
  }
}

// --------------------------------------------------------------- shortcut

/**
 * Show the binding Chrome actually holds. When a suggested key collides with
 * something already registered Chrome drops it silently and `getAll` returns
 * an empty `shortcut`, which is the only signal there is.
 */
async function renderShortcut() {
  let shortcut = '';
  try {
    const commands = await chrome.commands.getAll();
    shortcut = commands.find((c) => c.name === 'capture-full-page')?.shortcut || '';
  } catch {
    /* leave it unset; the rebind button still works */
  }

  els.shortcut.textContent = '';
  if (shortcut) {
    for (const part of shortcut.split('+')) {
      const kbd = document.createElement('kbd');
      kbd.textContent = part;
      els.shortcut.append(kbd);
    }
  } else {
    els.shortcut.append(document.createTextNode('No shortcut assigned'));
  }

  // An <a href="chrome://..."> is inert on an extension page. Only
  // chrome.tabs.create can open one, and it needs no "tabs" permission.
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'shortcut__link';
  link.textContent = shortcut ? 'Change' : 'Assign';
  link.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  els.shortcut.append(link);
}

// ------------------------------------------------------------------- wiring

function wireDestinations() {
  for (const key of ['download', 'copyToClipboard']) {
    const el = $(key);
    el.addEventListener('change', () => {
      const other = key === 'download' ? 'copyToClipboard' : 'download';
      if (!el.checked && !$(other).checked) {
        el.checked = true;
        els.destinationWarn.hidden = false;
        return;
      }
      els.destinationWarn.hidden = true;
      commit({ [key]: el.checked });
    });
  }
}

function wire() {
  els.template.addEventListener('input', () => {
    renderPreview();
    scheduleFilenameWrite();
  });
  els.template.addEventListener('blur', () => {
    if (!els.template.value.trim()) {
      clearTimeout(filenameTimer);
      els.template.value = current.filenameTemplate;
      renderPreview();
      setStatus('Kept the previous filename');
      return;
    }
    flushFilename();
  });
  els.template.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      flushFilename();
    }
  });

  for (const radio of formatInputs()) {
    radio.addEventListener('change', () => {
      renderPreview();
      commit({ format: radio.value });
    });
  }

  els.jpegQuality.addEventListener('input', renderQualityReadout);
  els.jpegQuality.addEventListener('change', () => applyNumber('jpegQuality'));

  $('prePass').addEventListener('change', (e) => commit({ prePass: e.target.checked }));
  $('overlayPolicy').addEventListener('change', (e) => commit({ overlayPolicy: e.target.value }));

  for (const key of ['settleMs', 'captureIntervalMs', 'pixelBudget']) {
    const el = $(key);
    el.addEventListener('change', () => applyNumber(key));
    el.addEventListener('blur', () => applyNumber(key));
  }

  wireDestinations();

  // Two clicks, not an undo window. Ten local values, all visible immediately,
  // on a page nobody visits twice: the state machine costs more than it saves.
  let armed = false;
  const disarm = () => {
    armed = false;
    els.reset.textContent = 'Restore defaults';
    els.reset.classList.remove('is-armed');
  };
  els.reset.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      els.reset.textContent = 'Click again to restore defaults';
      els.reset.classList.add('is-armed');
      setTimeout(disarm, 5000);
      return;
    }
    disarm();
    current = { ...DEFAULTS };
    await chrome.storage.local.set(DEFAULTS);
    render(DEFAULTS);
    setStatus('Defaults restored');
  });
}

// --------------------------------------------------------------------- boot

applyBounds();
buildPresets();
buildChips();
wire();
current = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
render(current);
renderShortcut();
renderLastCapture();

// The worker writes `lastCapture` when a download settles, which can happen
// while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lastCapture) renderLastCapture();
});
