// Shared band renderer for capture fixtures.
//
// bands(container, count, startIndex) appends `count` bands, each exactly
// 100px tall and labelled with its index and its document offset. Read the
// stitched PNG and every band must appear exactly once, in order.

export function bands(container, count, startIndex = 0, offsetPx = 0) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const n = startIndex + i;
    const el = document.createElement('div');
    el.className = 'band';
    el.dataset.index = String(n);
    el.innerHTML =
      `<span class="idx">#${String(n).padStart(3, '0')}</span>` +
      `<span class="top">top ${offsetPx + n * 100}px</span>`;
    frag.appendChild(el);
  }
  container.appendChild(frag);
}

export function expectedHeight(count, extraPx = 0) {
  return count * 100 + extraPx;
}
