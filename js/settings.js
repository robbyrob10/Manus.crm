// ── SETTINGS WINDOW ──
// Opens from the signed-in person at the bottom of the sidebar. It holds the view size and text size (VIEW in
// VIEW, the Leads page panel widths (panelSizes), the sounds, the keyboard shortcuts list,
// and backup and restore. Keys pressed inside the window stay in it, so page shortcuts (the dialer's number keys,
// C to call…) never fire behind it. Ctrl + / Ctrl − / Ctrl 0 still work: VIEW catches them before anything else.
(() => {
  const dialog = $('settingsDialog');
  const PANELS = { leads: $('stWidthLeads'), comms: $('stWidthComms') };

  // Every shortcut in the CRM, grouped by where it works. Each key combination is a list of keys pressed together.
  const SHORTCUTS = [
    ['Anywhere', [
      [[['Ctrl', '+']], 'Bigger text'],
      [[['Ctrl', '−']], 'Smaller text'],
      [[['Ctrl', '0']], 'Text size back to normal'],
      [[['Esc']], 'Close the top window or menu, then the dialer']
    ]],
    ['Leads page', [
      [[['↑'], ['↓']], 'Previous or next lead'],
      [[['/']], 'Search leads'],
      [[['C']], 'Call the lead'],
      [[['T']], 'Text the lead'],
      [[['W']], 'WhatsApp the lead'],
      [[['E']], 'Email the lead'],
      [[['Enter']], 'Send the message you are typing'],
      [[['Shift', 'Enter']], 'New line in a message'],
      [[['←'], ['→']], 'Resize a panel, on the line between two panels']
    ]],
    ['Dialer (while it is open)', [
      [[['0–9'], ['*'], ['#']], 'Type the number, or keypad tones during a call'],
      [[['Backspace']], 'Erase the last digit'],
      [[['Enter']], 'Call or answer'],
      [[['Ctrl', 'V']], 'Paste a number'],
      [[['←'], ['↑'], ['→'], ['↓']], 'Move the dialer when it is selected (add Shift for bigger steps)']
    ]],
    ['Email page', [
      [[['C']], 'New email'],
      [[['/']], 'Search mail'],
      [[['J'], ['K']], 'Next or previous email'],
      [[['U']], 'Back to the list'],
      [[['E']], 'Archive'],
      [[['#']], 'Delete'],
      [[['S']], 'Star'],
      [[['R']], 'Reply'],
      [[['A']], 'Reply all'],
      [[['F']], 'Forward'],
      [[['Ctrl', 'Enter']], 'Send, while writing an email'],
      [[['Ctrl', 'K']], 'Add a link, while writing an email']
    ]]
  ];

  // ── VIEW ──
  $('stSize').innerHTML = '<option value="auto">Auto (fits this screen)</option>'
    + VIEW.SIZES.map(([inches]) => `<option value="${inches}">${inches}" screen</option>`).join('');
  const oneDecimal = n => Math.round(n * 10) / 10;
  function renderView() {
    const v = VIEW.get();
    $('stSize').value = String(v.size);
    $('stLists').value = v.lists;
    $('stFontScale').value = String(v.fontScale);
    $('stStep').value = v.step === 0 ? '0' : (v.step > 0 ? '+' : '−') + Math.abs(v.step).toFixed(1);
    $('stNow').textContent = `Size now: ${oneDecimal(remPx())} px. Saved in this browser. Ctrl + / Ctrl − / Ctrl 0 change the text size too.`;
  }
  $('stSize').addEventListener('change', e => VIEW.set({ size: e.target.value === 'auto' ? 'auto' : Number(e.target.value) }));
  $('stLists').addEventListener('change', e => VIEW.set({ lists: e.target.value }));
  $('stFontScale').addEventListener('change', e => VIEW.set({ fontScale: Number(e.target.value) }));
  $('stSmaller').addEventListener('click', () => VIEW.set({ step: VIEW.get().step - VIEW.STEP }));
  $('stBigger').addEventListener('click', () => VIEW.set({ step: VIEW.get().step + VIEW.STEP }));
  $('stResetView').addEventListener('click', VIEW.reset);

  // ── PANEL WIDTHS ──
  function renderPanels() {
    Object.entries(PANELS).forEach(([name, input]) => {
      const { min, max } = panelSizes.limits(name), width = panelSizes.width(name);
      input.min = min;
      input.max = max;
      input.value = width;
      $(input.id + 'Value').value = width;
    });
  }
  Object.entries(PANELS).forEach(([name, input]) => {
    input.addEventListener('input', () => { panelSizes.set(name, Number(input.value)); renderPanels(); });
    input.addEventListener('change', panelSizes.save);
  });
  $('stResetWidths').addEventListener('click', () => { panelSizes.reset(); renderPanels(); });

  // ── SOUNDS ──
  // The volume and which groups play (sounds.js). Letting go of the slider, or ticking a group on, plays a sample.
  function renderSounds() {
    $('stVolume').value = sounds.settings.volume;
    $('stVolumeValue').textContent = sounds.settings.volume + '%';
    $('stSounds').querySelectorAll('[data-sound]').forEach(box => { box.checked = sounds.settings[box.dataset.sound]; });
  }
  $('stVolume').addEventListener('input', e => { sounds.set({ volume: Number(e.target.value) }); renderSounds(); });
  $('stVolume').addEventListener('change', () => sounds.sample('alerts'));
  $('stSounds').addEventListener('change', e => {
    const group = e.target.dataset.sound;
    sounds.set({ [group]: e.target.checked });
    if (e.target.checked) sounds.sample(group);
  });

  // ── KEYBOARD SHORTCUTS ──
  const combo = keys => keys.map(k => `<kbd>${esc(k)}</kbd>`).join(' + ');
  $('stKeys').innerHTML = SHORTCUTS.map(([where, list]) => `<div><h4>${esc(where)}</h4><dl>${
    list.map(([combos, what]) => `<dt>${combos.map(combo).join(' ')}</dt><dd>${esc(what)}</dd>`).join('')
  }</dl></div>`).join('');
  $('stKeysBtn').addEventListener('click', e => {
    const show = $('stKeys').hidden;
    $('stKeys').hidden = !show;
    e.currentTarget.setAttribute('aria-expanded', show);
    e.currentTarget.textContent = show ? 'Hide shortcuts' : 'Show shortcuts';
  });

  // ── BACKUP AND RESTORE ──
  // A backup is one JSON file: every "nv." quick-storage item as saved, and every record of the CRM's databases
  // (the names starting with "nv-", like the mail and its files). Files are written into it as data URLs.
  // Restoring checks the file, asks first, replaces all of it, then restarts the CRM.
  const BACKUP = 'crm-backup', FORMAT = 1;
  const SKIP = new Set(['nv.campaignLock']); // held by an open tab for a few seconds; never part of a backup
  const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const finished = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
  function localKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    return keys.filter(k => k.startsWith('nv.') && !SKIP.has(k));
  }
  const crmDatabases = async () => (await indexedDB.databases()).filter(d => d.name && d.name.startsWith('nv-'));
  function openDatabase(name, version, create) {
    const req = version ? indexedDB.open(name, version) : indexedDB.open(name);
    if (create) req.onupgradeneeded = () => create(req.result);
    return done(req);
  }

  const dataUrl = blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  async function pack(v) {
    if (v instanceof Blob) return { __file: await dataUrl(v), type: v.type, name: v instanceof File ? v.name : undefined };
    if (Array.isArray(v)) return Promise.all(v.map(pack));
    if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await pack(x)])));
    return v;
  }
  function unpack(v) {
    if (Array.isArray(v)) return v.map(unpack);
    if (!v || typeof v !== 'object') return v;
    if (typeof v.__file === 'string') {
      const bytes = Uint8Array.from(atob(v.__file.slice(v.__file.indexOf(',') + 1)), c => c.charCodeAt(0));
      return v.name ? new File([bytes], v.name, { type: v.type }) : new Blob([bytes], { type: v.type });
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)]));
  }

  async function makeBackup() {
    try {
      const local = Object.fromEntries(localKeys().map(k => [k, localStorage.getItem(k)]));
      const databases = [];
      for (const { name } of await crmDatabases()) {
        const db = await openDatabase(name);
        const stores = [];
        for (const storeName of db.objectStoreNames) {
          const s = db.transaction(storeName).objectStore(storeName);
          const [keys, values] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
          stores.push({ name: storeName, keyPath: s.keyPath, autoIncrement: s.autoIncrement,
            records: await Promise.all(values.map(async (value, i) => ({ key: keys[i], value: await pack(value) }))) });
        }
        databases.push({ name, version: db.version, stores });
        db.close();
      }
      const file = new Blob([JSON.stringify({ kind: BACKUP, format: FORMAT, savedAt: Date.now(), local, databases })], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = `crm-backup-${inputValue(Date.now()).slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      toast(`Backup file made: ${link.download}. Look for it in your Downloads folder.`, [], 8000);
    } catch {
      toast('The backup could not be made. Nothing was changed.');
    }
  }

  // A backup file must look exactly like one this CRM makes before anything is replaced.
  function isBackup(b) {
    const isText = v => typeof v === 'string';
    return !!b && b.kind === BACKUP && b.format === FORMAT && Number.isFinite(b.savedAt)
      && b.local && typeof b.local === 'object' && Object.entries(b.local).every(([k, v]) => k.startsWith('nv.') && !SKIP.has(k) && isText(v))
      && Array.isArray(b.databases) && b.databases.every(d => d && isText(d.name) && d.name.startsWith('nv-') && Number.isInteger(d.version) && d.version > 0
        && Array.isArray(d.stores) && d.stores.every(s => s && isText(s.name) && Array.isArray(s.records)));
  }

  async function chooseFile(file) {
    let backup = null;
    try { backup = JSON.parse(await file.text()); } catch { backup = null; }
    if (!isBackup(backup)) { toast('That file is not a backup from this CRM. Nothing was changed.'); return; }
    const when = showTime(backup.savedAt, { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' + clockTime(backup.savedAt);
    if (await ask({ title: 'Replace your data?', text: `This backup was made ${when}. Restoring it replaces everything saved in this browser, then the CRM restarts. This can’t be undone.`, ok: 'Replace my data', danger: true })) restore(backup);
  }

  async function restore(backup) {
    try {
      const have = await crmDatabases();
      // Databases in the backup: emptied and filled from it. A database the backup does not have is emptied.
      const plan = [...backup.databases, ...have.filter(d => !backup.databases.some(b => b.name === d.name)).map(d => ({ name: d.name, stores: null }))];
      for (const d of plan) {
        const exists = have.some(x => x.name === d.name);
        const db = await openDatabase(d.name, exists ? 0 : d.version, fresh => d.stores.forEach(s =>
          fresh.createObjectStore(s.name, s.keyPath === null ? { autoIncrement: !!s.autoIncrement } : { keyPath: s.keyPath, autoIncrement: !!s.autoIncrement })));
        const names = d.stores ? d.stores.map(s => s.name) : [...db.objectStoreNames];
        if (!names.every(n => db.objectStoreNames.contains(n))) { db.close(); throw new Error('mismatch'); }
        if (names.length) {
          const records = d.stores ? d.stores.map(s => s.records.map(r => ({ key: r.key, value: unpack(r.value) }))) : [];
          const tx = db.transaction(names, 'readwrite');
          names.forEach((n, i) => {
            const s = tx.objectStore(n);
            s.clear();
            (records[i] || []).forEach(r => s.keyPath === null ? s.put(r.value, r.key) : s.put(r.value));
          });
          await finished(tx);
        }
        db.close();
      }
      localKeys().forEach(k => localStorage.removeItem(k));
      Object.entries(backup.local).forEach(([k, v]) => localStorage.setItem(k, v));
      location.reload();
    } catch {
      toast('The backup could not be restored. It does not match this CRM, or the browser blocked saving.', [], 8000);
    }
  }

  $('stBackup').addEventListener('click', makeBackup);
  $('stRestore').addEventListener('click', () => $('stRestoreFile').click());
  $('stRestoreFile').addEventListener('change', e => { const file = e.target.files[0]; e.target.value = ''; if (file) chooseFile(file); });

  // ── OPEN AND CLOSE ──
  $('settingsBtn').addEventListener('click', () => {
    renderView();
    renderPanels();
    renderSounds();
    dialog.showModal();
  });
  $('settingsClose').addEventListener('click', () => dialog.close());
  $('settingsDone').addEventListener('click', () => dialog.close());
  dialog.addEventListener('mousedown', e => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('keydown', e => e.stopPropagation());
  addEventListener('viewchange', () => { if (dialog.open) { renderView(); renderPanels(); } });
  addEventListener('resize', () => { if (dialog.open) { renderView(); renderPanels(); } });
})();
