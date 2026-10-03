// Runs in the page head, before anything shows, so a saved view size is used from the first frame.

// ── SAVED DATA ──
// Everything the CRM keeps in this browser's quick storage is saved under a name that starts with "nv.".
// A save the browser refuses raises "savefail". A refused save raises savefail.
const store = {
  read(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { dispatchEvent(new Event('savefail')); return false; }
  }
};

// ── VIEW SIZE ──
// Screen fit works out the page's root font size, which sets every size in the app.
// Settings can swap its automatic screen-size part for a chosen screen size (--view-base) and add a text step
// (--view-step, in 0.5px steps). Ctrl + / Ctrl − / Ctrl 0 change the same text step, in place of the browser's zoom.
// The sidebar size (full, or icons only) and the list spacing are kept here too, as data-nav and data-lists on the page.
const VIEW = (() => {
  // Screen size in inches → root font size in px (16 is the approved size).
  const SIZES = [[14, 14], [15.6, 14.5], [17, 15], [19, 15.5], [21.5, 16], [24, 16], [27, 17.5], [28, 18], [32, 19], [34, 20]];
  const STEP = .5, MIN_STEP = -4, MAX_STEP = 8, KEY = 'nv.view';
  const NAV_EXPLICIT_KEY = 'nv.nav-explicit';
  const navBreakpoint = matchMedia('(max-width: 80rem)');
  const valid = v => ({
    size: SIZES.some(([inches]) => inches === v.size) ? v.size : 'auto',
    step: Number.isFinite(v.step) ? Math.min(Math.max(Math.round(v.step / STEP) * STEP, MIN_STEP), MAX_STEP) : 0,
    fontScale: [0.9, 1, 1.1, 1.2].includes(Number(v.fontScale)) ? Number(v.fontScale) : 1,
    nav: v.nav === 'small' ? 'small' : 'full',
    lists: ['comfortable', 'compact'].includes(v.lists) ? v.lists : 'normal'
  });
  let navExplicit = store.read(NAV_EXPLICIT_KEY, false) === true;
  let view = valid(store.read(KEY, {}));

  function apply() {
    const root = document.documentElement.style, base = SIZES.find(([inches]) => inches === view.size);
    if (base) root.setProperty('--view-base', base[1] + 'px');
    else root.removeProperty('--view-base');
    root.setProperty('--view-step', view.step + 'px');
    root.setProperty('--crm-font-scale', view.fontScale);
    document.documentElement.dataset.nav = navBreakpoint.matches && !navExplicit ? 'small' : view.nav;
    document.documentElement.dataset.lists = view.lists;
  }
  function set(changes) {
    if (Object.prototype.hasOwnProperty.call(changes, 'nav')) {
      navExplicit = true;
      store.write(NAV_EXPLICIT_KEY, true);
    }
    view = valid({ ...view, ...changes });
    store.write(KEY, view);
    apply();
    dispatchEvent(new Event('viewchange'));
  }

  const updateNavDefault = () => {
    apply();
    dispatchEvent(new Event('viewchange'));
  };
  if (navBreakpoint.addEventListener) navBreakpoint.addEventListener('change', updateNavDefault);
  else navBreakpoint.addListener(updateNavDefault);

  addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const dir = e.code === 'NumpadAdd' || e.key === '=' || e.key === '+' ? 1
      : e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_' ? -1
      : e.code === 'Numpad0' || e.key === '0' ? 0 : null;
    if (dir === null) return;
    e.preventDefault();
    set({ step: dir ? view.step + dir * STEP : 0 });
  }, true);

  apply();
  return {
    SIZES, STEP,
    get: () => ({ ...view }),
    set,
    reset: () => set({ size: 'auto', step: 0, fontScale: 1, lists: 'normal' })
  };
})();
