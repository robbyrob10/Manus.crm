// ── EMAIL ──
// One mail app. It shows as the full Email page, or smaller inside Panel 3's Email tab — the same screen moved between the two.
// Mail, drafts and attached files are saved in this browser (IndexedDB). Settings, folders, rules and templates use localStorage.
// mailServer below is a stand-in: sending saves the email in Sent but does not reach a real mail server yet,
// and email opens can only be seen once a real tracking server reports them through mailServer.reportOpen().
const mail = (() => {
  // ── SAVED SETTINGS ──
  const COLORS = ['#1A73E8', '#188038', '#E8710A', '#9334E6', '#D93025', '#12B5CB', '#E52592', '#B06000'];
  const settings = Object.assign({ undoSeconds: 10, trackDefault: true, autoSignature: true, split: 'none', density: 'default', rail: false, seenOpens: 0 }, store.read('nv.mail.settings', {}));
  // Each address belongs to one rep (rep). An address saved by an older version without one belongs to the signed-in rep.
  const accounts = store.read('nv.mail.accounts', sample('mailAccounts', []));
  accounts.forEach(a => { a.rep ??= user.name; });
  const folders = store.read('nv.mail.folders', []);            // [{ id, name, color }] in sidebar order
  const rules = store.read('nv.mail.rules', []);
  const templates = store.read('nv.mail.templates', sample('mailTemplates', []));
  const SYSTEM_ORDER = ['inbox', 'snoozed', 'sent', 'scheduled', 'drafts', 'tracked', 'favorites', 'spam', 'trash', 'deleted', 'all'];
  let systemOrder = store.read('nv.mail.order', SYSTEM_ORDER).filter(id => SYSTEM_ORDER.includes(id));
  SYSTEM_ORDER.forEach(id => { if (!systemOrder.includes(id)) systemOrder.push(id); });

  const saveSettings = () => store.write('nv.mail.settings', settings);
  const saveAccounts = () => store.write('nv.mail.accounts', accounts);
  const saveFolders = () => store.write('nv.mail.folders', folders);
  const saveRules = () => store.write('nv.mail.rules', rules);
  const saveTemplates = () => store.write('nv.mail.templates', templates);
  const saveOrder = () => store.write('nv.mail.order', systemOrder);

  // ── MAIL STORAGE (IndexedDB) ──
  // Files stay in memory too, so the session keeps working if the browser blocks saving.
  const fileCache = new Map();
  const db = (() => {
    let opening = null;
    const api = { ok: true };
    const open = () => opening ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('nv-mail', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('threads', { keyPath: 'id' }); req.result.createObjectStore('files'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const run = async (name, mode, fn) => {
      const d = await open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction(name, mode), req = fn(tx.objectStore(name));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    };
    const guard = p => p.catch(() => { api.ok = false; dispatchEvent(new Event('savefail')); return null; });
    api.threads = () => run('threads', 'readonly', s => s.getAll());
    api.put = t => guard(run('threads', 'readwrite', s => s.put(t)));
    api.remove = id => guard(run('threads', 'readwrite', s => s.delete(id)));
    api.putFile = (id, blob) => guard(run('files', 'readwrite', s => s.put(blob, id)));
    api.getFile = id => run('files', 'readonly', s => s.get(id)).catch(() => null);
    api.removeFile = id => guard(run('files', 'readwrite', s => s.delete(id)));
    api.clear = () => guard(Promise.all([run('threads', 'readwrite', s => s.clear()), run('files', 'readwrite', s => s.clear())]));
    return api;
  })();

  let threads = [];
  // True until the saved mail has been read from the browser; the list says "Loading mail…" until then.
  let loading = true;
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const save = t => { db.put(JSON.parse(JSON.stringify(t))); changed(); };

  async function fileBlob(id) {
    if (fileCache.has(id)) return fileCache.get(id);
    const blob = await db.getFile(id);
    if (blob) fileCache.set(id, blob);
    return blob || null;
  }
  function addFile(file) {
    const id = uid('f');
    fileCache.set(id, file);
    db.putFile(id, file);
    return { id, name: file.name || 'file', type: file.type || 'application/octet-stream', size: file.size };
  }
  // A forwarded file is shared by two emails, so it is only removed when no email uses it any more.
  function dropFiles(list) {
    list.forEach(f => {
      if (threads.some(t => t.msgs.some(m => m.files.some(x => x.id === f.id)))) return;
      fileCache.delete(f.id);
      db.removeFile(f.id);
    });
  }
  function removeThread(t) {
    threads = threads.filter(x => x !== t);
    db.remove(t.id);
    dropFiles(t.msgs.flatMap(m => m.files));
    changed();
  }

  // ── SAMPLE MAILBOX (first run only) ──
  // Built from the mailbox in sample-data.js until a real mail account is connected.
  function seedThreads() {
    const me = a => ({ name: a.name, email: a.email });
    const contact = email => { const l = leadByEmail(email); return { name: l ? fullName(l) : email, email }; };
    const p = text => text.split('\n').map(line => line ? `<div>${esc(line)}</div>` : '<div><br></div>').join('');
    const sig = a => `<div><br></div><div class="gm-sig">${a.signature}</div>`;
    const hi = (email, text) => `Hi ${(leadByEmail(email) || { first: 'there' }).first},\n\n${text}`;
    const msg = (a, s) => {
      const body = s.hi ? hi(s.peer, s.body) : s.body;
      const base = { id: uid('m'), cc: [], bcc: [], subject: s.subject, at: ago(s.mins), scheduledAt: 0, files: [] };
      return s.out
        ? { ...base, from: me(a), to: [s.peer], html: p(body) + (s.draft ? '' : sig(a)), out: true, read: true, draft: !!s.draft, tracked: s.draft ? settings.trackDefault : true, opens: (s.opens || []).map(ago) }
        : { ...base, from: contact(s.peer), to: [a.email], html: p(body), out: false, read: !s.unread, draft: false, tracked: false, opens: [] };
    };
    const sampleAccounts = sample('mailAccounts', []);
    return sample('mailbox', []).map(({ account: i, msgs, ...t }) => {
      const a = account((sampleAccounts[i] || {}).id);
      return { starred: false, important: false, snoozeUntil: 0, bumpAt: 0, deletedAt: 0, ...t, account: a.id, msgs: msgs.map(s => msg(a, s)) };
    });
  }

  // ── SMALL HELPERS ──
  const account = id => accounts.find(a => a.id === id) || accounts[0];
  // Reps see only their own addresses and mail; the owner's All reps shows every rep's.
  const shownAccounts = () => accounts.filter(a => canSee(a.rep));
  const shownThreads = () => { const ids = new Set(shownAccounts().map(a => a.id)); return threads.filter(t => ids.has(t.account)); };
  // New emails go from the address picked in the sidebar, else the signed-in rep's first address.
  const defaultAccount = () => shownAccounts().find(a => a.id === ui.scope) || accounts.find(a => a.rep === user.name) || shownAccounts()[0] || null;
  const mine = email => accounts.some(a => a.email === String(email).toLowerCase());
  const nameFor = email => { const a = accounts.find(x => x.email === email); if (a) return 'me'; const l = leadByEmail(email); return l ? fullName(l) : email; };
  const firstName = email => { const l = leadByEmail(email); if (l) return l.first; const w = String(email).split('@')[0].split(/[._-]/)[0]; return /^[a-z]{2,}$/i.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''; };
  const baseSubject = s => String(s || '').replace(/^((re|fwd?|fw):\s*)+/i, '').trim();
  const parser = new DOMParser();
  const textOf = html => (parser.parseFromString(String(html || '').replace(/<(br|\/div|\/p|\/li|\/h\d|\/tr|\/blockquote)\b[^>]*>/gi, '$& '), 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim();
  const validAddr = a => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(a);
  const avatarColor = s => COLORS[[...String(s)].reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length];
  const initialOf = s => (String(s).trim()[0] || '?').toUpperCase();

  // Only safe HTML reaches the screen: no scripts, frames, forms or event handlers. <style> blocks are dropped so pasted
  // email designs can't restyle the CRM; inline styles are kept.
  function clean(html) {
    const doc = parser.parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('script, style, iframe, frame, object, embed, link, meta, base, form, input, button, select, textarea, noscript').forEach(n => n.remove());
    doc.body.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => {
      const name = a.name.toLowerCase(), value = a.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src' || name === 'action') && value.startsWith('javascript:'))) n.removeAttribute(a.name);
    }));
    doc.body.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
    return doc.body.innerHTML;
  }
  const looksLikeHtml = text => /^\s*<(!doctype|html|head|body|table|div|p|span|a|img|h[1-6]|ul|ol|br|center|font|b|strong|i|em|section)\b/i.test(text) && /<\/[a-z0-9]+>|\/>/i.test(text);
  const textToHtml = text => String(text).split('\n').map(line => line ? `<div>${esc(line)}</div>` : '<div><br></div>').join('');

  function fmtListDate(ts) {
    if (daysAgo(ts) === 0) return clockTime(ts);
    if (wall(ts).y === wall().y) return showTime(ts, { month: 'short', day: 'numeric' });
    return showTime(ts, { month: 'numeric', day: 'numeric', year: '2-digit' });
  }
  const fmtFullDate = ts => `${showTime(ts, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${clockTime(ts)} (${timeAgo(ts).replace('Just now', 'just now')})`;
  const fmtWhen = ts => `${showTime(ts, { weekday: 'short', month: 'short', day: 'numeric' })}, ${clockTime(ts)}`;
  // Eastern time: `days` from today at hour h, or the next given weekday (0 = Sunday) at hour h.
  const dayAt = (days, h) => { const w = wall(); return fromWall(w.y, w.mo, w.d + days, h); };
  const nextWeekday = (wd, h) => dayAt((wd - wall().wd + 7) % 7 || 7, h);

  // ── THREAD FACTS ──
  const gone = t => t.folder === 'spam' || t.folder === 'trash' || t.folder === 'deleted';
  const snoozed = t => t.snoozeUntil > Date.now();
  const sentMsgs = t => t.msgs.filter(m => m.out && !m.draft && !m.scheduledAt);
  const shown = t => t.msgs.filter(m => !m.draft);
  const lastMsg = t => { const s = shown(t); return s[s.length - 1] || t.msgs[t.msgs.length - 1]; };
  const threadAt = t => Math.max(t.bumpAt || 0, lastMsg(t).at);
  const isUnread = t => t.msgs.some(m => !m.out && !m.read);
  const hasFiles = t => t.msgs.some(m => m.files.length);
  const subjectOf = t => baseSubject(t.msgs[0].subject) ? t.msgs[0].subject : '(no subject)';
  const trackedMsg = t => { const s = sentMsgs(t).filter(m => m.tracked); return s[s.length - 1] || null; };

  // ── FOLDERS ("views") ──
  const VIEWS = {
    inbox:     { name: 'Inbox', icon: 'inbox', test: t => t.folder === 'inbox' && !snoozed(t) },
    snoozed:   { name: 'Snoozed', icon: 'snooze', test: t => snoozed(t) && !gone(t), hideEmpty: true },
    sent:      { name: 'Sent', icon: 'send', test: t => !gone(t) && sentMsgs(t).length > 0 },
    scheduled: { name: 'Scheduled', icon: 'schedule', test: t => t.msgs.some(m => m.scheduledAt) && !gone(t), hideEmpty: true },
    drafts:    { name: 'Drafts', icon: 'draft', test: t => t.folder !== 'deleted' && t.msgs.some(m => m.draft) },
    tracked:   { name: 'Tracked', icon: 'doneall', test: t => !gone(t) && !!trackedMsg(t) },
    favorites: { name: 'Favorites', icon: 'star', test: t => t.starred && !gone(t) },
    spam:      { name: 'Spam', icon: 'spam', test: t => t.folder === 'spam' },
    trash:     { name: 'Trash', icon: 'delete', test: t => t.folder === 'trash' },
    deleted:   { name: 'Recently deleted', icon: 'history', test: t => t.folder === 'deleted' },
    all:       { name: 'All Mail', icon: 'mail', test: t => !gone(t) && shown(t).length > 0 }
  };
  const viewName = id => VIEWS[id] ? VIEWS[id].name : (folders.find(f => f.id === id) || { name: 'Folder' }).name;
  const viewTest = id => VIEWS[id] ? VIEWS[id].test : t => t.folder === id;
  const folderLabel = t => t.folder === 'inbox' ? 'Inbox' : t.folder === 'archive' ? '' : VIEWS[t.folder] ? VIEWS[t.folder].name : (folders.find(f => f.id === t.folder) || {}).name || '';

  // ── SEARCH ──
  // Gmail-style words: from: to: subject: has:attachment is:unread is:read is:starred is:important is:tracked is:opened
  // in:<folder> after:2026-09-01 before:2026-09-30, "exact phrase", and -word to leave a word out.
  function parseQuery(q) {
    const out = { words: [], not: [], ops: [] };
    const re = /(-?)(?:(\w+):)?("([^"]*)"|\S+)/g;
    let m;
    while ((m = re.exec(q))) {
      const neg = m[1] === '-', key = (m[2] || '').toLowerCase(), value = (m[4] ?? m[3]).toLowerCase();
      if (!value) continue;
      if (key) out.ops.push({ key, value, neg });
      else (neg ? out.not : out.words).push(value);
    }
    return out;
  }
  const dateOf = v => { const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/); return m ? fromWall(+m[1], m[2] - 1, +m[3]) : null; };
  const searchText = t => [subjectOf(t), ...t.msgs.flatMap(m => [m.from.name, m.from.email, ...m.to, ...m.cc, textOf(m.html), ...m.files.map(f => f.name)])].join(' ').toLowerCase();
  function matches(t, q) {
    const hay = searchText(t);
    if (!q.words.every(w => hay.includes(w)) || q.not.some(w => hay.includes(w))) return false;
    return q.ops.every(({ key, value, neg }) => {
      let ok;
      if (key === 'from') ok = t.msgs.some(m => (m.from.email + ' ' + m.from.name).toLowerCase().includes(value));
      else if (key === 'to') ok = t.msgs.some(m => [...m.to, ...m.cc, ...m.bcc].join(' ').includes(value));
      else if (key === 'subject') ok = subjectOf(t).toLowerCase().includes(value);
      else if (key === 'has') ok = value === 'attachment' ? hasFiles(t) : true;
      else if (key === 'is') ok = { unread: isUnread(t), read: !isUnread(t), starred: t.starred, important: t.important, tracked: !!trackedMsg(t), opened: !!(trackedMsg(t) && trackedMsg(t).opens.length), snoozed: snoozed(t) }[value] ?? true;
      else if (key === 'in') { const id = Object.keys(VIEWS).find(k => k === value || VIEWS[k].name.toLowerCase() === value) || (folders.find(f => f.name.toLowerCase() === value) || {}).id; ok = id ? viewTest(id)(t) : false; }
      else if (key === 'after' || key === 'before') { const d = dateOf(value); ok = d === null || (key === 'after' ? threadAt(t) >= d : threadAt(t) < d); }
      else ok = hay.includes(value);
      return neg ? !ok : ok;
    });
  }

  // ── RULES ──
  // Checked for every email that arrives, and for existing mail when "Also apply to matching conversations" is ticked.
  function ruleMatches(r, t, m) {
    const has = (field, text) => !field || String(text).toLowerCase().includes(field.toLowerCase());
    const text = subjectOf(t) + ' ' + textOf(m.html);
    return has(r.from, m.from.email + ' ' + m.from.name) && has(r.to, [...m.to, ...m.cc].join(' ')) && has(r.subject, m.subject)
      && (!r.words || r.words.toLowerCase().split(/\s+/).every(w => text.toLowerCase().includes(w))) && (!r.hasAttachment || m.files.length > 0);
  }
  function applyRule(r, t, m) {
    if (r.folder) t.folder = r.folder;
    if (r.star) t.starred = true;
    if (r.important) t.important = true;
    if (r.read) m.read = true;
  }
  const hasCondition = r => !!(r.from || r.to || r.subject || r.words || r.hasAttachment);

  // ── SCREEN STATE ──
  const PAGE = 50;
  const ui = { mode: 'compact', view: 'inbox', scope: 'all', query: '', chip: 'all', page: 0, open: null, selected: new Set(), expanded: new Set(), opensShown: new Set(), drawer: false };
  const splitMode = () => ui.mode === 'full' ? settings.split : 'none';
  const scoped = () => shownThreads().filter(t => ui.scope === 'all' || t.account === ui.scope);
  const find = id => threads.find(t => t.id === id) || null;

  const root = document.createElement('div');
  root.className = 'gm';
  root.innerHTML = `
    <header class="gm-head">
      <button class="gm-ib" data-m="menu" title="Main menu" aria-label="Main menu">${mi('menu', 22)}</button>
      <div class="gm-search">
        <span class="gm-search-ic">${mi('search', 20)}</span>
        <input id="gmSearch" type="search" placeholder="Search mail" autocomplete="off" aria-label="Search mail">
        <button class="gm-ib sm" data-m="clear-search" id="gmSearchClear" title="Clear search" aria-label="Clear search" hidden>${mi('close', 18)}</button>
        <button class="gm-ib sm" data-m="adv" id="gmAdvBtn" title="Show search options" aria-label="Show search options" aria-expanded="false">${mi('tune', 20)}</button>
        <div class="gm-adv" id="gmAdv" hidden></div>
      </div>
      <div class="gm-head-right">
        <button class="gm-ib" data-m="bell" id="gmBell" title="Email opens" aria-label="Email opens" aria-expanded="false">${mi('bell', 22)}<i class="gm-count" id="gmBellCount"></i></button>
        <button class="gm-ib" data-m="settings" title="Email settings" aria-label="Email settings">${mi('settings', 22)}</button>
      </div>
      <div class="gm-flyout" id="gmFlyout" hidden></div>
    </header>
    <div class="gm-body">
      <aside class="gm-side" id="gmSide"></aside>
      <div class="gm-scrim" data-m="menu"></div>
      <section class="gm-card">
        <div class="gm-panes" id="gmPanes">
          <div class="gm-listpane" id="gmList"></div>
          <div class="gm-readpane" id="gmRead"></div>
        </div>
      </section>
      <button class="gm-fab" data-m="compose">${mi('edit', 22)}Compose</button>
    </div>`;
  const q$ = id => root.querySelector('#' + id);

  // ── SIDEBAR ──
  function viewCount(id) {
    const list = scoped().filter(viewTest(id));
    if (id === 'drafts' || id === 'scheduled' || id === 'spam') return list.length;
    if (id === 'inbox' || folders.some(f => f.id === id)) return list.filter(isUnread).length;
    return 0;
  }
  function navItem(id, list) {
    const v = VIEWS[id], f = folders.find(x => x.id === id), n = viewCount(id);
    const on = !ui.query && ui.view === id;
    return `<div class="gm-nav${on ? ' on' : ''}" role="button" tabindex="0" data-view="${id}" data-list="${list}" draggable="true" title="${esc(viewName(id))}">
      ${f ? `<span class="gm-fdot" style="background:${f.color}"></span>` : mi(v.icon, 20)}<span class="gm-nav-name">${esc(viewName(id))}</span><b>${n || ''}</b></div>`;
  }
  const shownSystemViews = () => systemOrder.filter(id => !VIEWS[id].hideEmpty || scoped().some(VIEWS[id].test));
  // Panel 3 picks a folder from a drop-down: the same folders as the sidebar, with the same unread counts.
  function folderItems() {
    const item = id => { const n = viewCount(id); return { label: viewName(id) + (n ? ` · ${n}` : ''), cls: !ui.query && ui.view === id ? 'selected' : '', run: () => goView(id) }; };
    return [...shownSystemViews().map(item), ...(folders.length ? [{ label: 'Folders' }, ...folders.map(f => item(f.id))] : [])];
  }
  function renderSide() {
    const system = shownSystemViews();
    const unreadIn = id => shownThreads().filter(t => (id === 'all' || t.account === id) && VIEWS.inbox.test(t) && isUnread(t)).length;
    q$('gmSide').innerHTML = `
      <button class="gm-compose" data-m="compose">${mi('edit', 22)}<span>Compose</span></button>
      <nav class="gm-navlist" data-list="system">${system.map(id => navItem(id, 'system')).join('')}</nav>
      <div class="gm-side-head"><span>Folders</span><button class="gm-ib xs" data-m="new-folder" title="Create folder" aria-label="Create folder">${mi('add', 18)}</button></div>
      <nav class="gm-navlist" data-list="custom">${folders.map(f => navItem(f.id, 'custom')).join('') || '<div class="gm-side-empty">No folders yet</div>'}</nav>
      <div class="gm-side-rule"></div>
      <div class="gm-side-head"><span>Accounts</span><button class="gm-ib xs" data-m="add-account" title="Add email address" aria-label="Add email address">${mi('add', 18)}</button></div>
      <nav class="gm-accts">
        <div class="gm-acct${ui.scope === 'all' ? ' on' : ''}" role="button" tabindex="0" data-scope="all" title="All inboxes together">${mi('group', 18)}<span class="gm-nav-name">All accounts</span><b>${unreadIn('all') || ''}</b></div>
        ${shownAccounts().map(a => `<div class="gm-acct${ui.scope === a.id ? ' on' : ''}" role="button" tabindex="0" data-scope="${a.id}" title="${esc(a.email)}"><span class="gm-acct-dot" style="background:${a.color}">${esc(initialOf(a.email))}</span><span class="gm-nav-name">${esc(a.email)}</span><b>${unreadIn(a.id) || ''}</b></div>`).join('')}
      </nav>
      <button class="gm-storage" data-m="storage" title="See what is stored">${mi('cloud', 18)}<span><span id="gmStorageText">${storageText}</span><i class="gm-meterbar"><i id="gmStorageFill" style="width:${storagePct}%"></i></i></span></button>`;
  }

  // ── STORAGE METER ──
  // Real numbers from the browser: how much this CRM has saved on this computer, and how much room the browser allows.
  let storageText = 'Checking storage…', storagePct = 0, storageTimer = 0;
  const fmtBytes = b => b >= 1073741824 ? (b / 1073741824).toFixed(b >= 10737418240 ? 0 : 1) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  async function estimate() {
    try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch { return null; }
  }
  function refreshStorage() {
    clearTimeout(storageTimer);
    storageTimer = setTimeout(async () => {
      const e = await estimate();
      storageText = e ? `${fmtBytes(e.used)} of ${fmtBytes(e.quota)} used` : 'Storage size not available';
      storagePct = e && e.quota ? Math.max(1, Math.min(100, e.used / e.quota * 100)) : 0;
      const text = q$('gmStorageText'), fill = q$('gmStorageFill');
      if (text) { text.textContent = storageText; fill.style.width = storagePct + '%'; }
      if (dlg.kind === 'settings' && dlg.tab === 'storage') renderSettings();
    }, 400);
  }

  // ── LIST ──
  function listThreads() {
    let list = scoped();
    if (ui.query.trim()) {
      const q = parseQuery(ui.query), inFolder = q.ops.some(o => o.key === 'in' && !o.neg);
      list = list.filter(t => (inFolder || !gone(t)) && matches(t, q));
    } else list = list.filter(viewTest(ui.view));
    const chip = { unread: isUnread, starred: t => t.starred, files: hasFiles, tracked: t => !!trackedMsg(t) }[ui.chip];
    if (chip) list = list.filter(chip);
    const at = t => { const s = t.msgs.find(m => m.scheduledAt); return ui.view === 'scheduled' && s ? -s.scheduledAt : threadAt(t); };
    return list.sort((a, b) => at(b) - at(a));
  }
  function trackMark(m) {
    if (!m) return '';
    const n = m.opens.length;
    const tip = n ? `Opened ${n} ${n === 1 ? 'time' : 'times'} · last ${timeAgo(Math.max(...m.opens)).toLowerCase()}` : 'Tracked · sent, not opened yet';
    return `<span class="gm-trk${n ? ' seen' : ''}" title="${tip}" aria-label="${tip}">${mi(n ? 'doneall' : 'done', 16)}</span>`;
  }
  function peopleLine(t) {
    const shownMsgs = shown(t), draft = t.msgs.some(m => m.draft) ? ' <span class="gm-draft">Draft</span>' : '';
    const outbound = ['sent', 'scheduled', 'drafts'].includes(ui.view) && !ui.query || shownMsgs.every(m => m.out);
    let names;
    if (outbound) {
      const m = lastMsg(t);
      names = 'To: ' + ([...m.to, ...m.cc].map(nameFor).join(', ') || '(no recipients)');
    } else {
      const senders = new Set(shownMsgs.filter(m => !m.out).map(m => m.from.name));
      names = [...new Set(shownMsgs.map(m => m.out ? 'me' : senders.size > 1 ? m.from.name.split(' ')[0] : m.from.name))].join(', ');
    }
    return `${esc(names)}${shownMsgs.length > 1 ? ` <span class="gm-n">${shownMsgs.length}</span>` : ''}${draft}`;
  }
  function rowHtml(t) {
    const last = lastMsg(t), sched = t.msgs.find(m => m.scheduledAt), a = account(t.account);
    const date = sched ? `<span class="gm-sched">${mi('schedule', 14)}${fmtListDate(sched.scheduledAt)}</span>` : t.snoozeUntil > Date.now() ? `<span class="gm-sched">${mi('snooze', 14)}${fmtListDate(t.snoozeUntil)}</span>` : fmtListDate(threadAt(t));
    const tag = ui.scope === 'all' && shownAccounts().length > 1 ? `<span class="gm-tag" title="${esc(a.email)}"><i style="background:${a.color}"></i>${esc(a.email.split('@')[0])}</span>` : '';
    const label = ui.query || ['all', 'favorites', 'tracked'].includes(ui.view) ? folderLabel(t) : '';
    return `<div class="gm-row${isUnread(t) ? ' unread' : ''}${ui.selected.has(t.id) ? ' sel' : ''}${ui.open === t.id ? ' open' : ''}" data-t="${t.id}" draggable="true">
      <label class="gm-row-check" title="Select"><input type="checkbox" data-sel${ui.selected.has(t.id) ? ' checked' : ''} aria-label="Select"></label>
      <button class="gm-row-star${t.starred ? ' on' : ''}" data-m="star" title="${t.starred ? 'Starred' : 'Not starred'}" aria-label="${t.starred ? 'Unstar' : 'Star'}">${mi(t.starred ? 'star' : 'starline', 20)}</button>
      <button class="gm-row-imp${t.important ? ' on' : ''}" data-m="important" title="${t.important ? 'Important' : 'Not important'}" aria-label="${t.important ? 'Mark not important' : 'Mark important'}">${mi('important', 20)}</button>
      <span class="gm-row-from">${trackMark(trackedMsg(t))}<span class="gm-row-names">${peopleLine(t)}</span></span>
      ${tag}
      <button type="button" class="gm-row-main" aria-label="Open: ${esc(subjectOf(t) || '(no subject)')}">${label ? `<span class="gm-label">${esc(label)}</span>` : ''}<span class="gm-row-subj">${esc(subjectOf(t))}</span><span class="gm-row-snip">${esc(textOf(last.html).slice(0, 160))}</span></button>
      ${hasFiles(t) ? `<span class="gm-row-clip" title="Has attachment">${mi('attach', 16)}</span>` : ''}
      <span class="gm-row-date">${date}</span>
      <span class="gm-row-hover">
        <button class="gm-ib xs" data-m="row-archive" title="Archive" aria-label="Archive">${mi('archive', 18)}</button>
        <button class="gm-ib xs" data-m="row-delete" title="Delete" aria-label="Delete">${mi('delete', 18)}</button>
        <button class="gm-ib xs" data-m="row-read" title="${isUnread(t) ? 'Mark as read' : 'Mark as unread'}" aria-label="${isUnread(t) ? 'Mark as read' : 'Mark as unread'}">${mi(isUnread(t) ? 'read' : 'unread', 18)}</button>
        <button class="gm-ib xs" data-m="row-snooze" title="Snooze" aria-label="Snooze">${mi('snooze', 18)}</button>
      </span></div>`;
  }
  // The buttons that act on the ticked conversations (or on the open one), fitted to the folder being viewed.
  // Over an open email only the main ones show (archive, delete, read or unread); spam, snooze and move are in its ⋮ menu.
  const barBtn = (m, icon, title) => `<button class="gm-ib sm" data-m="${m}" title="${title}" aria-label="${title}"${m.endsWith('menu') ? ' aria-haspopup="menu"' : ''}>${mi(icon, 20)}</button>`;
  function actionButtons(ids, reading = false) {
    const list = ids.map(find).filter(Boolean), v = ui.query ? 'search' : ui.view, b = barBtn;
    const anyUnread = list.some(isUnread), usual = v !== 'spam' && v !== 'trash' && v !== 'deleted';
    const out = [];
    if (v === 'spam') out.push(b('act-notspam', 'inbox', 'Not spam'));
    else if (usual) out.push(b('act-archive', 'archive', 'Archive'));
    if (usual && !reading) out.push(b('act-spam', 'spam', 'Report spam'));
    out.push(v === 'drafts' ? b('act-discard', 'delete', 'Discard drafts') : v === 'trash' ? b('act-delete', 'deleteforever', 'Delete forever') : v === 'deleted' ? b('act-delete', 'deleteforever', 'Delete permanently') : b('act-delete', 'delete', 'Delete'));
    out.push(b(anyUnread ? 'act-read' : 'act-unread', anyUnread ? 'read' : 'unread', anyUnread ? 'Mark as read' : 'Mark as unread'));
    if (reading) return out.join('');
    if (usual) out.push(b('act-snoozemenu', 'snooze', 'Snooze'));
    out.push(b('act-movemenu', 'move', 'Move to'), b('act-moremenu', 'more', 'More'));
    return out.join('');
  }
  function renderList() {
    const all = listThreads(), pages = Math.max(1, Math.ceil(all.length / PAGE));
    ui.page = Math.min(ui.page, pages - 1);
    ui.selected.forEach(id => { if (!all.some(t => t.id === id)) ui.selected.delete(id); });
    const list = all.slice(ui.page * PAGE, ui.page * PAGE + PAGE), sel = [...ui.selected];
    const from = all.length ? ui.page * PAGE + 1 : 0, to = Math.min(all.length, (ui.page + 1) * PAGE);
    const scopeName = ui.scope === 'all' ? '' : ` · ${account(ui.scope).email}`;
    const title = ui.query ? 'Search results' : viewName(ui.view);
    const emptyText = loading ? 'Loading mail…' : ui.query ? 'No messages matched your search' : ui.chip !== 'all' ? 'Nothing matches this filter' : `Nothing in ${viewName(ui.view)}`;
    const splitIcon = { none: 'splitnone', vertical: 'splitv', horizontal: 'splith' }[settings.split];
    q$('gmList').innerHTML = `
      <div class="gm-bar">
        <label class="gm-selall" title="Select all on this page"><input type="checkbox" id="gmSelAll" aria-label="Select all"${sel.length && list.every(t => ui.selected.has(t.id)) ? ' checked' : ''}></label>
        <button class="gm-ib xs" data-m="selmenu" title="Select" aria-label="Select options" aria-haspopup="menu">${mi('dropdown', 18)}</button>
        ${sel.length ? `<span class="gm-selcount">${sel.length}</span>${actionButtons(sel)}` : `<button class="gm-ib sm" data-m="refresh" title="Refresh" aria-label="Refresh">${mi('refresh', 20)}</button>`}
        ${!sel.length && ['trash', 'deleted', 'spam'].includes(ui.view) && !ui.query && all.length ? `<button class="gm-link" data-m="empty-folder">Empty ${viewName(ui.view)} now</button>` : ''}
        <span class="gm-spacer"></span>
        <span class="gm-range">${from}–${to} of ${all.length}</span>
        <button class="gm-ib xs" data-m="page-prev" title="Newer" aria-label="Newer"${ui.page === 0 ? ' disabled' : ''}>${mi('left', 20)}</button>
        <button class="gm-ib xs" data-m="page-next" title="Older" aria-label="Older"${ui.page >= pages - 1 ? ' disabled' : ''}>${mi('right', 20)}</button>
        <button class="gm-viewbtn" data-m="viewmenu" title="Reading pane and density" aria-label="Reading pane and density" aria-haspopup="menu">${mi(splitIcon, 20)}${mi('dropdown', 16)}</button>
      </div>
      <div class="gm-chips" role="group" aria-label="Quick filters">${[['all', 'All'], ['unread', 'Unread'], ['starred', 'Starred'], ['files', 'Has attachment'], ['tracked', 'Tracked']].map(([k, label]) => `<button class="gm-chip${ui.chip === k ? ' on' : ''}" data-chip="${k}">${label}</button>`).join('')}</div>
      <div class="gm-title"><button class="gm-folderbtn" data-m="foldermenu" title="Switch folder" aria-haspopup="menu"><span>${esc(title)}</span>${mi('dropdown', 18)}</button><small>${esc(scopeName)}</small></div>
      ${['trash', 'deleted'].includes(ui.view) && !ui.query ? `<div class="gm-banner">${ui.view === 'trash' ? 'Emails in Trash move to Recently deleted after 30 days.' : 'Emails here are removed for good after 30 days.'}</div>` : ''}
      <div class="gm-rows" id="gmRows">${list.map(rowHtml).join('') || `<div class="gm-empty">${mi('inbox', 48)}<div>${esc(emptyText)}</div></div>`}</div>`;
  }

  // ── READING ──
  let fileUrls = [];
  function msgFiles(m) {
    if (!m.files.length) return '';
    return `<div class="gm-files"><div class="gm-files-head">${m.files.length} ${m.files.length === 1 ? 'attachment' : 'attachments'}</div><div class="gm-files-grid">${m.files.map(f => `
      <a class="gm-file" data-file="${f.id}" data-type="${esc(f.type)}" download="${esc(f.name)}" href="#" title="Download ${esc(f.name)}">
        <span class="gm-file-thumb">${f.type.startsWith('image/') ? '<img alt="">' : mi(f.type === 'application/pdf' ? 'pdf' : 'file', 32)}</span>
        <span class="gm-file-foot"><span class="gm-file-name">${esc(f.name)}</span><span class="gm-file-size">${fmtBytes(f.size)}</span></span></a>`).join('')}</div></div>`;
  }
  async function hydrateFiles(scope) {
    for (const a of scope.querySelectorAll('[data-file]')) {
      const blob = await fileBlob(a.dataset.file);
      if (!blob || !a.isConnected) { if (!blob) a.classList.add('missing'); continue; }
      const url = URL.createObjectURL(blob);
      fileUrls.push(url);
      a.href = url;
      const img = a.querySelector('img');
      if (img) img.src = url;
    }
  }
  function trackingCard(m) {
    const n = m.opens.length, list = [...m.opens].sort((a, b) => b - a);
    const head = n ? `${mi('doneall', 18)}<span><b>Opened ${n} ${n === 1 ? 'time' : 'times'}</b> · last opened ${timeAgo(list[0]).toLowerCase()}</span>`
      : `${mi('done', 18)}<span><b>Sent</b> · not opened yet</span>`;
    return `<div class="gm-tcard${n ? ' seen' : ''}">${head}${n ? `<button class="gm-link" data-m="opens" data-msg="${m.id}">${ui.opensShown.has(m.id) ? 'Hide' : 'Details'}</button>` : ''}</div>
      ${ui.opensShown.has(m.id) ? `<ol class="gm-opens">${list.map((at, i) => `<li>${fmtWhen(at)}<span>${i === 0 ? 'latest' : ''}</span></li>`).join('')}<li class="gm-opens-sent">Sent ${fmtWhen(m.at)}</li></ol>` : ''}`;
  }
  function msgHtml(t, m, folded) {
    const who = m.out ? account(t.account).name : m.from.name;
    const face = avatar(who, { photo: (leadByEmail(m.from.email) || {}).photo, size: 'lg', tint: avatarColor(m.from.email), letters: 1 });
    if (folded) return `<div class="gm-msg folded" data-msg="${m.id}" role="button" tabindex="0">${face}<b>${esc(who)}</b><span class="gm-msg-snip">${esc(textOf(m.html).slice(0, 120))}</span><span class="gm-msg-date">${fmtListDate(m.at)}</span></div>`;
    const to = [...m.to.map(nameFor), ...m.cc.map(nameFor)].join(', ') + (m.out && m.bcc.length ? `, bcc: ${m.bcc.map(nameFor).join(', ')}` : '');
    return `<div class="gm-msg" data-msg="${m.id}">
      <div class="gm-msg-head" data-m="fold">${face}<div class="gm-msg-who"><b>${esc(who)}</b> <span>&lt;${esc(m.from.email)}&gt;</span><div class="gm-msg-to">to ${esc(to || 'no one')}</div></div>
        <span class="gm-msg-date">${m.scheduledAt ? 'Scheduled' : `<span class="gm-long">${fmtFullDate(m.at)}</span><span class="gm-short">${fmtListDate(m.at)}</span>`}</span>
        ${m.scheduledAt ? '' : `<button class="gm-ib sm" data-m="msg-reply" data-msg="${m.id}" title="Reply" aria-label="Reply">${mi('reply', 20)}</button>`}</div>
      ${m.scheduledAt ? `<div class="gm-tcard">${mi('schedule', 18)}<span><b>Send scheduled</b> for ${fmtWhen(m.scheduledAt)}</span><button class="gm-link" data-m="cancel-schedule" data-msg="${m.id}">Cancel send</button></div>` : m.out && m.tracked ? trackingCard(m) : ''}
      <div class="gm-msg-body">${clean(m.html)}</div>${msgFiles(m)}</div>`;
  }
  function renderRead() {
    fileUrls.forEach(u => URL.revokeObjectURL(u));
    fileUrls = [];
    const el = q$('gmRead'), t = ui.open && find(ui.open);
    q$('gmPanes').classList.toggle('reading', !!t);
    if (!t) { el.innerHTML = splitMode() === 'none' ? '' : `<div class="gm-read-empty">${mi('mail', 48)}<div>Select an email to read</div></div>`; return; }
    const msgs = shown(t), last = msgs[msgs.length - 1], a = account(t.account);
    const inbound = [...msgs].reverse().find(m => !m.out);
    const idea = !composers.inline && last && !last.out && !last.scheduledAt ? suggestReply({ kind: 'email', text: textOf(last.html), lead: leadByEmail(last.from.email) }) : '';
    const others = last ? [...new Set([...(last.out ? last.to : [last.from.email]), ...last.to, ...last.cc].filter(x => !mine(x)))] : [];
    const label = folderLabel(t), canReply = !!inbound || msgs.some(m => m.out && !m.scheduledAt);
    el.innerHTML = `
      <div class="gm-bar">
        ${splitMode() === 'none' ? `<button class="gm-ib sm gm-back" data-m="back" title="Back to ${esc(ui.query ? 'search results' : viewName(ui.view))}" aria-label="Back">${mi('back', 20, 22)}</button>` : ''}
        ${actionButtons([t.id], true)}
        <span class="gm-spacer"></span>
        ${t.snoozeUntil > Date.now() ? `<button class="gm-link" data-m="unsnooze">Unsnooze</button>` : ''}
        ${canReply ? `${barBtn('reply', 'reply', 'Reply')}${barBtn('forward', 'forward', 'Forward')}` : ''}
        <button class="gm-ib sm${t.starred ? ' gm-on' : ''}" data-m="read-star" title="${t.starred ? 'Unstar' : 'Star'}" aria-label="${t.starred ? 'Unstar' : 'Star'}">${mi(t.starred ? 'star' : 'starline', 20)}</button>
        ${barBtn('read-moremenu', 'more', 'More')}
      </div>
      <div class="gm-read" id="gmReadScroll">
        <div class="gm-subject"><h2>${esc(subjectOf(t))}</h2>${label ? `<span class="gm-label">${esc(label)}</span>` : ''}${shownAccounts().length > 1 ? `<span class="gm-tag" title="This conversation is in ${esc(a.email)}"><i style="background:${a.color}"></i>${esc(a.email)}</span>` : ''}</div>
        ${msgs.map(m => msgHtml(t, m, m !== last && !ui.expanded.has(m.id))).join('')}
        ${canReply ? `<div class="gm-replybar${composers.inline ? ' hidden' : ''}">
          ${idea ? `<button class="gm-suggest" data-m="suggest" title="Start a reply with this">${mi('sparkle', 16)}<span>${esc(idea)}</span></button>` : ''}
          <div class="gm-replybtns">
            <button class="gm-btn" data-m="reply">${mi('reply', 18)}Reply</button>
            ${others.length > 1 ? `<button class="gm-btn" data-m="replyall">${mi('replyall', 18)}Reply all</button>` : ''}
            <button class="gm-btn" data-m="forward">${mi('forward', 18)}Forward</button>
          </div></div>` : ''}
        <div class="gm-inline-slot" id="gmInlineSlot"></div>
      </div>`;
    hydrateFiles(el);
    if (composers.inline && composers.inline.t === t) q$('gmInlineSlot').append(composers.inline.root);
  }

  // ── TRACKING BELL ──
  function allOpens() {
    return shownThreads().filter(t => !gone(t)).flatMap(t => sentMsgs(t).filter(m => m.tracked).flatMap(m => m.opens.map(at => ({ at, t, m })))).sort((a, b) => b.at - a.at);
  }
  function renderBell() {
    const fresh = allOpens().filter(o => o.at > settings.seenOpens).length;
    q$('gmBellCount').textContent = fresh ? (fresh > 9 ? '9+' : fresh) : '';
    const fly = q$('gmFlyout');
    if (fly.hidden) return;
    const list = allOpens().slice(0, 30);
    fly.innerHTML = `<div class="gm-fly-head">Email opens</div>${list.map(o => `
      <button class="gm-fly-item${o.at > settings.seenOpens ? ' new' : ''}" data-open-t="${o.t.id}">${mi('doneall', 18)}<span><b>${esc([...o.m.to].map(nameFor).join(', '))}</b> opened “${esc(o.m.subject || '(no subject)')}”<small>${timeAgo(o.at)}</small></span></button>`).join('') || '<div class="gm-fly-empty">No opens yet. Tracked emails show here when they are opened.</div>'}`;
  }

  // ── ADVANCED SEARCH CARD ──
  function renderAdv() {
    const box = q$('gmAdv');
    box.innerHTML = `
      <div class="gm-adv-grid">
        <label>From</label><input data-adv="from" type="text" autocomplete="off">
        <label>To</label><input data-adv="to" type="text" autocomplete="off">
        <label>Subject</label><input data-adv="subject" type="text" autocomplete="off">
        <label>Has the words</label><input data-adv="words" type="text" autocomplete="off">
        <label>Doesn't have</label><input data-adv="not" type="text" autocomplete="off">
        <label>Date within</label><div class="gm-adv-row"><select data-adv="within"><option value="">Any time</option><option value="1">1 day</option><option value="3">3 days</option><option value="7">1 week</option><option value="14">2 weeks</option><option value="30">1 month</option><option value="60">2 months</option><option value="180">6 months</option><option value="365">1 year</option></select><span>of</span><input data-adv="date" type="date"></div>
        <label>Search</label><select data-adv="in"><option value="">All Mail</option>${[...SYSTEM_ORDER.filter(id => id !== 'all'), ...folders.map(f => f.id)].map(id => `<option value="${id}">${esc(viewName(id))}</option>`).join('')}</select>
        <span></span><label class="gm-adv-check"><input data-adv="files" type="checkbox"> Has attachment</label>
      </div>
      <div class="gm-adv-foot"><button class="gm-btn" data-m="adv-filter">Create filter</button><button class="gm-btn primary" data-m="adv-search">Search</button></div>`;
  }
  const advValues = () => Object.fromEntries([...q$('gmAdv').querySelectorAll('[data-adv]')].map(i => [i.dataset.adv, i.type === 'checkbox' ? i.checked : i.value.trim()]));
  function advQuery(v) {
    const quote = s => /\s/.test(s) ? `"${s}"` : s;
    const parts = [];
    if (v.from) parts.push('from:' + quote(v.from));
    if (v.to) parts.push('to:' + quote(v.to));
    if (v.subject) parts.push('subject:' + quote(v.subject));
    if (v.words) parts.push(v.words);
    if (v.not) parts.push(...v.not.split(/\s+/).map(w => '-' + w));
    if (v.files) parts.push('has:attachment');
    if (v.in) parts.push('in:' + v.in);
    if (v.within) {
      const w = wall((v.date && dateOf(v.date)) || Date.now()), iso = days => new Date(Date.UTC(w.y, w.mo, w.d + days)).toISOString().slice(0, 10);
      parts.push('after:' + iso(-v.within), 'before:' + iso(Number(v.within) + 1));
    }
    return parts.join(' ');
  }

  function render() {
    root.classList.toggle('full', ui.mode === 'full');
    root.classList.toggle('compact', ui.mode === 'compact');
    root.classList.toggle('rail', ui.mode === 'full' && settings.rail);
    root.classList.toggle('drawer', ui.mode === 'compact' && ui.drawer);
    root.dataset.split = splitMode();
    root.dataset.density = settings.density;
    q$('gmSearchClear').hidden = !ui.query;
    renderSide();
    renderList();
    renderRead();
    renderBell();
  }

  // ── COMPOSER ──
  // One composer, used in three places. New emails and popped-out replies: a window on the Email page ('window'), or
  // filling the mail screen in Panel 3 ('pane'); both are composers.window. Replies: inline under an open email ('inline').
  const composers = { window: null, inline: null };
  const standalone = c => c.where !== 'inline';
  const EMOJIS = '😀 😃 😄 😁 😊 🙂 😉 😍 😎 🤔 😅 😂 🙏 👍 👎 👏 🙌 🤝 💪 👀 ✅ ❌ ⭐ 🔥 🎉 🚀 💡 📌 📎 📅 ⏰ 📞 📧 💼 📈 💰 🏦 ✍️ ❤️ 👋'.split(' ');
  const TEXT_COLORS = ['#303642', '#434343', '#666666', '#999999', '#B7B7B7', '#D93025', '#E8710A', '#F9AB00', '#188038', '#12B5CB', '#1A73E8', '#3F51B5', '#9334E6', '#E52592'];
  const BG_COLORS = ['#FFFFFF', '#F1F3F4', '#FCE8E6', '#FEF7E0', '#E6F4EA', '#E8F0FE', '#F3E8FD', '#FFD5D2', '#FFE082', '#B7E1CD', '#C2E7FF', '#D7AEFB', '#F8BBD0', '#FFF59D'];
  const FONTS = [['Sans Serif', 'Arial, Helvetica, sans-serif'], ['Serif', "Georgia, 'Times New Roman', serif"], ['Fixed width', "'Courier New', monospace"], ['Wide', "'Arial Black', sans-serif"], ['Narrow', "'Arial Narrow', sans-serif"], ['Comic Sans MS', "'Comic Sans MS', cursive"], ['Garamond', 'Garamond, serif'], ['Tahoma', 'Tahoma, sans-serif'], ['Trebuchet MS', "'Trebuchet MS', sans-serif"], ['Verdana', 'Verdana, sans-serif']];
  const BIG_FILE = 25 * 1048576;

  const sigHtml = a => a.signature ? `<div class="gm-sig">-- <br>${a.signature}</div>` : '';
  const fromOf = a => ({ name: a.name, email: a.email });
  function newDraft({ a, to = [], cc = [], bcc = [], subject = '', html = '', files = [], quote = '', kind = 'new' }) {
    return { id: uid('m'), from: fromOf(a), to, cc, bcc, subject, html, at: Date.now(), out: true, read: true, draft: true, sending: false, scheduledAt: 0, tracked: settings.trackDefault, opens: [], files, quote, kind };
  }
  const startBody = (a, lead = '') => `${lead}<div><br></div>${settings.autoSignature && a.signature ? `<div><br></div>${sigHtml(a)}` : ''}`;

  function replyDraft(t, kind, base) {
    const msgs = shown(t), last = base || msgs[msgs.length - 1], a = accounts.find(x => last.to.includes(x.email) || last.from.email === x.email) || account(t.account);
    let to = [], cc = [], html, files = [], quote = '';
    if (kind === 'forward') {
      html = `<div><br></div>${settings.autoSignature && a.signature ? sigHtml(a) : ''}<div><br></div><div class="gm-fwd">---------- Forwarded message ---------<br>From: <b>${esc(last.from.name)}</b> &lt;${esc(last.from.email)}&gt;<br>Date: ${esc(fmtWhen(last.at))}<br>Subject: ${esc(last.subject)}<br>To: ${esc(last.to.join(', '))}<br><br>${clean(last.html)}</div>`;
      files = last.files.map(f => ({ ...f }));
    } else {
      if (last.out) { to = [...last.to]; if (kind === 'replyall') cc = [...last.cc]; }
      else {
        to = [last.from.email];
        if (kind === 'replyall') cc = [...last.to, ...last.cc].filter(x => !mine(x) && x !== last.from.email);
      }
      html = startBody(a);
      quote = `<div class="gm-quote-head">On ${esc(fmtWhen(last.at))}, ${esc(last.from.name)} &lt;${esc(last.from.email)}&gt; wrote:</div><blockquote class="gm-quote">${clean(last.html)}</blockquote>`;
    }
    return newDraft({ a, to, cc, subject: (kind === 'forward' ? 'Fwd: ' : 'Re: ') + baseSubject(last.subject), html, files, quote, kind });
  }

  const tool = (c, icon, title, extra = '') => `<button class="gc-tool" data-c="${c}" title="${title}" aria-label="${title}"${extra}>${mi(icon, 20)}</button>`;
  const fbtn = (f, inner, title) => `<button class="gc-fb" data-f="${f}" title="${title}" aria-label="${title}">${inner}</button>`;
  function composerHtml(c) {
    const win = standalone(c), m = c.m;
    const kindIcon = { reply: 'reply', replyall: 'replyall', forward: 'forward' }[m.kind] || 'edit';
    return `
      ${win ? `<div class="gc-head" data-c="head"><span class="gc-title"></span><span class="gc-head-acts">
          ${c.where === 'window' ? `<button class="gc-hb" data-c="min" title="Minimize" aria-label="Minimize">${mi('minimize', 18)}</button>
          <button class="gc-hb" data-c="full" title="Full screen" aria-label="Full screen">${mi('fullscreen', 18)}</button>` : ''}
          <button class="gc-hb" data-c="close" title="Save &amp; close" aria-label="Save and close">${mi('close', 18)}</button></span></div>`
        : `<div class="gc-ihead">${mi(kindIcon, 20)}<span class="gc-ikind">${{ reply: 'Reply', replyall: 'Reply all', forward: 'Forward' }[m.kind] || 'Reply'}</span><span class="gc-spacer"></span>
          <button class="gc-hb" data-c="popout" title="Pop out reply" aria-label="Pop out reply">${mi('popout', 18)}</button></div>`}
      <div class="gc-scroll">
        <div class="gc-fields">
          <div class="gc-row gc-fromrow"${shownAccounts().length > 1 ? '' : ' hidden'}><span class="gc-lbl">From</span><button class="gc-from" data-c="from" title="Choose which address sends this" aria-haspopup="menu"><span class="gc-fromtext"></span>${mi('dropdown', 18)}</button></div>
          ${['to', 'cc', 'bcc'].map(k => `<div class="gc-row" data-row="${k}"${k !== 'to' && !m[k].length ? ' hidden' : ''}><span class="gc-lbl">${k === 'to' ? 'To' : k === 'cc' ? 'Cc' : 'Bcc'}</span><div class="gc-chips" data-chips="${k}"></div>${k === 'to' ? `<span class="gc-ccbcc"><button class="gc-link" data-c="show-cc">Cc</button><button class="gc-link" data-c="show-bcc">Bcc</button></span>` : ''}</div>`).join('')}
          ${win ? '<div class="gc-row"><input class="gc-subject" placeholder="Subject" aria-label="Subject" autocomplete="off"></div>' : ''}
        </div>
        <div class="gc-ai" hidden>
          <div class="gc-ai-head">${mi('sparkle', 18)}Help me write</div>
          <textarea class="gc-ai-prompt" rows="2" placeholder="Example: Tell Ray I’m working on his file"></textarea>
          <div class="gc-ai-row">
            <select class="gc-ai-tone" aria-label="Tone"><option value="professional">Professional</option><option value="friendly">Friendly</option><option value="formal">Formal</option><option value="short">Short &amp; direct</option></select>
            <select class="gc-ai-length" aria-label="Length"><option value="short">Short</option><option value="medium" selected>Medium</option><option value="long">Long</option></select>
            <span class="gc-spacer"></span>
            ${m.kind === 'reply' || m.kind === 'replyall' ? '<button class="gm-btn" data-c="ai-reply">Suggest a reply</button>' : ''}
            <button class="gm-btn" data-c="ai-cancel">Cancel</button><button class="gm-btn primary" data-c="ai-create">Create</button>
          </div>
        </div>
        <div class="gc-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message body" spellcheck="true"></div>
        <textarea class="gc-source" spellcheck="false" aria-label="HTML code" hidden></textarea>
        <button class="gc-trim" data-c="quote" title="Show trimmed content" aria-label="Show trimmed content" hidden>${mi('morehoriz', 18)}</button>
        <div class="gc-files"></div>
      </div>
      <div class="gc-note" role="alert"></div>
      <div class="gc-fmt" hidden>
        ${fbtn('undo', mi('undo', 18), 'Undo (Ctrl+Z)')}${fbtn('redo', mi('redo', 18), 'Redo (Ctrl+Y)')}<i class="gc-sep"></i>
        <select class="gc-sel" data-f="font" title="Font" aria-label="Font">${FONTS.map(([n, v]) => `<option value="${esc(v)}">${n}</option>`).join('')}</select>
        <select class="gc-sel" data-f="size" title="Size" aria-label="Size"><option value="1">Small</option><option value="3" selected>Normal</option><option value="5">Large</option><option value="7">Huge</option></select><i class="gc-sep"></i>
        ${fbtn('bold', '<b>B</b>', 'Bold (Ctrl+B)')}${fbtn('italic', '<i>I</i>', 'Italic (Ctrl+I)')}${fbtn('underline', '<u>U</u>', 'Underline (Ctrl+U)')}
        <button class="gc-fb" data-f="color" title="Text color" aria-label="Text color" aria-haspopup="true"><span class="gc-a">A</span><i class="gc-bar" data-bar="color"></i></button>
        <button class="gc-fb" data-f="highlight" title="Highlight color" aria-label="Highlight color" aria-haspopup="true">${mi('fill', 16)}<i class="gc-bar" data-bar="highlight"></i></button><i class="gc-sep"></i>
        <button class="gc-fb gc-fb-wide" data-f="align" title="Align" aria-label="Align" aria-haspopup="menu">${mi('alignleft', 18)}${mi('dropdown', 14)}</button>
        ${fbtn('ol', mi('ol', 18), 'Numbered list')}${fbtn('ul', mi('ul', 18), 'Bulleted list')}${fbtn('source', mi('code', 18), 'Edit HTML code')}
        <button class="gc-fb" data-f="morefmt" title="More formatting options" aria-label="More formatting options" aria-haspopup="menu">${mi('dropdown', 18)}</button>
      </div>
      <div class="gc-foot">
        <div class="gc-panel" hidden></div>
        <div class="gc-send"><button class="gc-sendbtn" data-c="send" title="Send (Ctrl+Enter)">Send</button><button class="gc-sendmore" data-c="schedule" title="Schedule send" aria-label="Schedule send" aria-haspopup="menu">${mi('dropdown', 20)}</button></div>
        <div class="gc-tools">
          ${tool('fmt', 'format', 'Formatting options')}${tool('attach', 'attach', 'Attach files')}${tool('link', 'link', 'Insert link (Ctrl+K)')}${tool('emoji', 'emoji', 'Insert emoji')}${tool('photo', 'image', 'Insert photo')}${tool('sig', 'signature', 'Insert signature')}${tool('tpl', 'template', 'Templates', ' aria-haspopup="menu"')}
          <button class="gc-tool gc-aibtn" data-c="ai" title="Help me write" aria-label="Help me write">${mi('sparkle', 18)}<span>Help me write</span></button>
          <button class="gc-tool gc-track" data-c="track"></button>
        </div>
        <span class="gc-spacer"></span><span class="gc-saved"></span>
        ${tool('more', 'more', 'More options', ' aria-haspopup="menu"')}${tool('discard', 'delete', 'Discard draft')}
      </div>
      <input type="file" class="gc-attach-input" multiple hidden>
      <input type="file" class="gc-photo-input" accept="image/*" hidden>`;
  }

  const cq = (c, sel) => c.root.querySelector(sel);
  const editorOf = c => cq(c, '.gc-editor');
  function makeComposer(where, t, m) {
    const c = { where, t, m, attached: threads.includes(t) && t.msgs.includes(m), panel: '', fmt: false, source: false, plain: false, min: false, full: false, range: null, saveTimer: 0, noteTimer: 0 };
    c.root = document.createElement('div');
    c.root.className = 'gc gc-' + where;
    c.root.innerHTML = composerHtml(c);
    editorOf(c).innerHTML = clean(m.html);
    if (standalone(c)) cq(c, '.gc-subject').value = m.subject;
    ['to', 'cc', 'bcc'].forEach(k => renderChips(c, k));
    updateComposer(c);
    bindComposer(c);
    return c;
  }
  function updateComposer(c) {
    const m = c.m;
    cq(c, '.gc-fromtext').textContent = `${m.from.name} <${m.from.email}>`;
    if (standalone(c)) cq(c, '.gc-title').textContent = cq(c, '.gc-subject').value.trim() || 'New Message';
    const tr = cq(c, '.gc-track');
    tr.classList.toggle('on', m.tracked);
    tr.innerHTML = mi(m.tracked ? 'visible' : 'hidden', 20);
    tr.title = m.tracked ? 'Tracking is on: you will see when this email is opened. Click to turn off.' : 'Tracking is off for this email. Click to turn on.';
    tr.setAttribute('aria-label', m.tracked ? 'Turn tracking off' : 'Turn tracking on');
    tr.setAttribute('aria-pressed', m.tracked);
    cq(c, '.gc-trim').hidden = !m.quote;
    cq(c, '.gc-fmt').hidden = !c.fmt || c.plain;
    cq(c, '[data-c="fmt"]').classList.toggle('on', c.fmt);
    cq(c, '[data-f="source"]').classList.toggle('on', c.source);
    editorOf(c).hidden = c.source;
    cq(c, '.gc-source').hidden = !c.source;
    c.root.classList.toggle('min', c.min);
    c.root.classList.toggle('full', c.full);
    if (c.where === 'window') cq(c, '[data-c="full"]').innerHTML = mi(c.full ? 'exitfull' : 'fullscreen', 18);
    renderAttachments(c);
  }
  function renderChips(c, key) {
    const box = cq(c, `[data-chips="${key}"]`), keep = box.querySelector('input');
    box.innerHTML = c.m[key].map((addr, i) => `<span class="gc-chip${validAddr(addr) ? '' : ' bad'}" title="${esc(addr)}">${esc(nameFor(addr) === 'me' ? addr : nameFor(addr))}<button data-c="unchip" data-key="${key}" data-i="${i}" title="Remove" aria-label="Remove ${esc(addr)}">${mi('close', 14)}</button></span>`).join('');
    const input = keep || Object.assign(document.createElement('input'), { className: 'gc-chip-input', type: 'text', autocomplete: 'off' });
    input.dataset.chip = key;
    input.setAttribute('aria-label', key === 'to' ? 'To' : key === 'cc' ? 'Cc' : 'Bcc');
    box.append(input);
  }
  function renderAttachments(c) {
    const total = c.m.files.reduce((n, f) => n + f.size, 0);
    cq(c, '.gc-files').innerHTML = c.m.files.map((f, i) => `<span class="gc-file" title="${esc(f.name)}">${mi(f.type.startsWith('image/') ? 'image' : 'attach', 16)}<span class="gc-file-name">${esc(f.name)}</span><small>${fmtBytes(f.size)}</small><button data-c="unfile" data-i="${i}" title="Remove" aria-label="Remove ${esc(f.name)}">${mi('close', 14)}</button></span>`).join('')
      + (total > BIG_FILE ? `<div class="gc-bignote">${mi('warning', 16)}These files add up to ${fmtBytes(total)}. Many mail servers refuse emails over 25 MB.</div>` : '');
  }
  // A problem with the recipients shows in the window, next to what needs fixing. Other messages use the dark bar (toast).
  function formError(c, text) { cq(c, '.gc-note').textContent = text; }

  // ── DRAFTS ──
  // A draft is saved as soon as something is typed, and again shortly after each change.
  function attachDraft(c) {
    if (c.attached) return;
    if (!threads.includes(c.t)) threads.push(c.t);
    else if (!c.t.msgs.includes(c.m)) c.t.msgs.push(c.m);
    c.attached = true;
  }
  function collect(c) {
    const m = c.m;
    if (c.source) m.html = cq(c, '.gc-source').value;
    else m.html = c.plain ? textToHtml(editorOf(c).innerText) : editorOf(c).innerHTML;
    if (standalone(c)) m.subject = cq(c, '.gc-subject').value;
    if (c.t.msgs.length === 1) { c.t.account = (accounts.find(a => a.email === m.from.email) || accounts[0]).id; }
  }
  function dirty(c) {
    attachDraft(c);
    cq(c, '.gc-saved').textContent = '';
    clearTimeout(c.saveTimer);
    c.saveTimer = setTimeout(() => saveDraft(c), 700);
  }
  function saveDraft(c) {
    clearTimeout(c.saveTimer);
    if (!c.attached || !c.m.draft) return;
    collect(c);
    c.m.at = Date.now();
    save(c.t);
    cq(c, '.gc-saved').textContent = 'Draft saved';
    renderSoon();
  }
  function destroy(c) {
    clearTimeout(c.saveTimer);
    if (popAnchor && c.root.contains(popAnchor)) closePop();
    c.root.remove();
    if (composers.window === c) composers.window = null;
    if (composers.inline === c) composers.inline = null;
  }
  function closeComposer(c) {
    saveDraft(c);
    destroy(c);
    if (c.where === 'inline') renderRead();
  }
  function discard(c) {
    const { t, m } = c;
    destroy(c);
    if (c.attached) {
      if (t.msgs.length === 1) removeThread(t);
      else { t.msgs = t.msgs.filter(x => x !== m); save(t); dropFiles(m.files); }
      toast('Draft discarded');
    }
    if (c.where === 'inline') renderRead();
    renderSoon();
  }

  // A new email or a popped-out reply: a window on the Email page, or filling the mail screen in Panel 3.
  function openComposer(t, m) {
    if (composers.window) closeComposer(composers.window);
    if (composers.inline && composers.inline.m === m) destroy(composers.inline);
    const c = composers.window = makeComposer(ui.mode === 'full' ? 'window' : 'pane', t, m);
    (c.where === 'window' ? document.body : root).append(c.root);
    focusComposer(c);
    return c;
  }
  // Moves a composer to a new-email place (see openComposer), keeping what was typed. Nothing typed yet: no draft is made.
  function moveComposer(c) {
    if (c.attached) saveDraft(c); else collect(c);
    destroy(c);
    openComposer(c.t, c.m);
  }
  function focusComposer(c) {
    const input = cq(c, '[data-chip="to"]');
    if (!c.m.to.length && c.m.kind !== 'reply' && c.m.kind !== 'replyall') { input.focus(); return; }
    const ed = editorOf(c);
    ed.focus();
    const r = document.createRange();
    r.setStart(ed, 0);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  function compose({ to = [], cc = [], bcc = [], subject = '', html = '' } = {}) {
    const a = defaultAccount();
    if (!a) { openSettings('accounts'); return null; }
    const m = newDraft({ a, to, cc, bcc, subject, html: startBody(a, html) });
    const t = { id: uid('t'), account: a.id, folder: 'archive', starred: false, important: false, snoozeUntil: 0, bumpAt: 0, deletedAt: 0, msgs: [m] };
    return openComposer(t, m);
  }
  function startInline(kind, base) {
    const t = find(ui.open);
    if (!t) return;
    if (composers.inline) closeComposer(composers.inline);
    composers.inline = makeComposer('inline', t, replyDraft(t, kind, base));
    renderRead();
    focusComposer(composers.inline);
    const scroller = q$('gmReadScroll');
    if (scroller) composers.inline.root.scrollIntoView({ block: 'nearest' });
  }
  function popOut(c) {
    moveComposer(c);
    renderRead();
  }

  // ── SENDING ──
  // Send waits a few seconds (Undo send) before it goes out. Closing the page in that time keeps it as a draft.
  const mailServer = {
    send() { return true; },
    // A real tracking server calls this when a tracked email is opened.
    reportOpen(messageId, at = Date.now()) {
      const t = threads.find(x => x.msgs.some(m => m.id === messageId));
      if (!t) return;
      t.msgs.find(m => m.id === messageId).opens.push(at);
      save(t);
      renderAll();
    }
  };
  function validate(c) {
    const m = c.m, all = [...m.to, ...m.cc, ...m.bcc], bad = all.find(x => !validAddr(x));
    if (!all.length) { formError(c, 'Add at least one recipient.'); cq(c, '[data-chip="to"]').focus(); return false; }
    if (bad) { formError(c, `“${bad}” is not a valid email address.`); return false; }
    return true;
  }
  function addPending(c) {
    ['to', 'cc', 'bcc'].forEach(k => { const input = cq(c, `[data-chip="${k}"]`); if (input && input.value.trim()) addAddrs(c, k, input.value); });
  }
  function finish(c) {
    const m = c.m;
    collect(c);
    if (m.quote) { m.html += `<div><br></div>${m.quote}`; m.quote = ''; }
    attachDraft(c);
    destroy(c);
    return m;
  }
  function send(c) {
    addPending(c);
    if (!validate(c)) return;
    const t = c.t, m = finish(c);
    Object.assign(m, { draft: false, sending: true, at: Date.now(), by: user.name });
    save(t);
    const timer = setTimeout(() => commit(t, m), settings.undoSeconds * 1000);
    toast('Message sent', [
      { label: 'Undo', run: () => { clearTimeout(timer); Object.assign(m, { draft: true, sending: false }); save(t); reopen(t, m); toast('Sending undone.'); } },
      { label: 'View message', run: () => openConversation(t.id) }
    ], settings.undoSeconds * 1000);
    if (c.where === 'inline') renderRead();
    renderAll();
  }
  function schedule(c, when) {
    addPending(c);
    if (!validate(c)) return;
    const t = c.t, m = finish(c);
    Object.assign(m, { draft: false, scheduledAt: when, by: user.name });
    save(t);
    toast(`Send scheduled for ${fmtWhen(when)}`, [{ label: 'View message', run: () => openConversation(t.id) }]);
    if (c.where === 'inline') renderRead();
    renderAll();
  }
  function commit(t, m) {
    if (!threads.includes(t)) return;
    Object.assign(m, { sending: false, scheduledAt: 0, draft: false });
    mailServer.send(t, m);
    save(t);
    const lead = [...m.to, ...m.cc, ...m.bcc].map(leadByEmail).find(Boolean);
    if (lead) logActivity(lead.id, 'email', `Email to ${[...m.to, ...m.cc, ...m.bcc][0]}: “${m.subject || '(no subject)'}”`);
    renderAll();
  }
  function reopen(t, m) {
    if (shown(t).length && ui.open === t.id) {
      if (composers.inline) closeComposer(composers.inline);
      composers.inline = makeComposer('inline', t, m);
      renderRead();
      focusComposer(composers.inline);
    } else openComposer(t, m);
  }
  function dueCheck() {
    const now = Date.now();
    threads.forEach(t => {
      t.msgs.forEach(m => { if (m.scheduledAt && m.scheduledAt <= now) { m.at = now; commit(t, m); } });
      if (t.snoozeUntil && t.snoozeUntil <= now) { t.snoozeUntil = 0; t.bumpAt = now; t.folder = t.folder === 'archive' ? 'inbox' : t.folder; t.msgs.forEach(m => { if (!m.out) m.read = false; }); save(t); renderAll(); }
    });
  }

  // ── EDITING ──
  function saveRange(c) {
    const s = getSelection();
    if (s.rangeCount && editorOf(c).contains(s.getRangeAt(0).commonAncestorContainer)) c.range = s.getRangeAt(0).cloneRange();
  }
  function restoreRange(c) {
    const ed = editorOf(c);
    ed.focus();
    const s = getSelection();
    s.removeAllRanges();
    if (c.range && ed.contains(c.range.commonAncestorContainer)) s.addRange(c.range);
    else { const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); s.addRange(r); }
  }
  function exec(c, cmd, value = null) {
    if (c.source) return;
    restoreRange(c);
    document.execCommand('styleWithCSS', false, cmd === 'hiliteColor' || cmd === 'foreColor');
    document.execCommand(cmd, false, value);
    saveRange(c);
    dirty(c);
  }
  function insertHtml(c, html) { exec(c, 'insertHTML', html); }
  const FORMAT = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough', left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', ol: 'insertOrderedList', ul: 'insertUnorderedList', undo: 'undo', redo: 'redo' };
  function format(c, f) {
    if (f === 'source') { toggleSource(c); return; }
    if (f === 'quote') { exec(c, 'formatBlock', 'blockquote'); return; }
    if (f === 'clear') { exec(c, 'removeFormat'); exec(c, 'unlink'); return; }
    if (f === 'color' || f === 'highlight') { openPanel(c, f); return; }
    if (f === 'align' || f === 'morefmt') {
      const b = cq(c, `[data-f="${f}"]`);
      if (popAnchor === b) { closePop(); return; }
      openPop(b, f === 'align'
        ? [['left', 'Align left'], ['center', 'Align center'], ['right', 'Align right']].map(([k, label]) => ({ label, run: () => format(c, k) }))
        : [['quote', 'Quote'], ['strike', 'Strikethrough'], ['clear', 'Remove formatting']].map(([k, label]) => ({ label, run: () => format(c, k) })), { list: true });
      return;
    }
    exec(c, FORMAT[f]);
  }
  function toggleSource(c) {
    if (c.plain) return;
    if (!c.source) cq(c, '.gc-source').value = editorOf(c).innerHTML;
    else editorOf(c).innerHTML = clean(cq(c, '.gc-source').value);
    c.source = !c.source;
    updateComposer(c);
    (c.source ? cq(c, '.gc-source') : editorOf(c)).focus();
    dirty(c);
  }
  // Pasted HTML code turns into the finished design right away and stays editable. Pasted formatted text keeps its look.
  function handlePaste(c, e) {
    const dt = e.clipboardData;
    const files = [...dt.files];
    if (files.length) { e.preventDefault(); addFiles(c, files, true); return; }
    const plain = dt.getData('text/plain'), html = dt.getData('text/html');
    e.preventDefault();
    if (c.plain) { exec(c, 'insertText', plain); return; }
    if (looksLikeHtml(plain)) { insertHtml(c, clean(plain)); toast('Pasted HTML is shown as the finished design.'); }
    else if (html) insertHtml(c, clean(html));
    else insertHtml(c, textToHtml(plain));
  }
  // Pictures can go inside the email or be sent as attachments. Very large files are accepted.
  function addFiles(c, files, inlineImages = false) {
    const pics = inlineImages ? files.filter(f => f.type.startsWith('image/')) : [];
    const rest = files.filter(f => !pics.includes(f));
    pics.forEach(f => {
      const r = new FileReader();
      r.onload = () => insertHtml(c, `<img src="${r.result}" alt="${esc(f.name)}" style="max-width:100%">`);
      r.readAsDataURL(f);
    });
    if (rest.length) { c.m.files.push(...rest.map(addFile)); renderAttachments(c); dirty(c); }
  }
  function insertSignature(c) {
    const a = accounts.find(x => x.email === c.m.from.email) || accounts[0];
    if (!a.signature) { openSettings('signature'); return; }
    const ed = editorOf(c), sig = ed.querySelector('.gm-sig');
    if (sig) { sig.outerHTML = sigHtml(a); dirty(c); } else insertHtml(c, `<div><br></div>${sigHtml(a)}`);
  }
  function setFrom(c, a) {
    c.m.from = fromOf(a);
    const sig = editorOf(c).querySelector('.gm-sig');
    if (sig) { if (a.signature) sig.outerHTML = sigHtml(a); else sig.remove(); }
    updateComposer(c);
    dirty(c);
  }
  function insertTemplate(c, tpl) {
    if (standalone(c) && !cq(c, '.gc-subject').value.trim()) cq(c, '.gc-subject').value = tpl.subject;
    const ed = editorOf(c);
    if (!textOf(ed.innerHTML.replace(/<div class="gm-sig">[\s\S]*$/, ''))) {
      const sig = ed.querySelector('.gm-sig');
      ed.innerHTML = clean(tpl.html) + (sig ? `<div><br></div>${sig.outerHTML}` : '');
      dirty(c);
    } else insertHtml(c, clean(tpl.html));
    updateComposer(c);
  }
  function saveAsTemplate(c) {
    collect(c);
    const name = (c.m.subject.trim() || textOf(c.m.html).slice(0, 40) || 'Template');
    const body = c.m.html.replace(/<div><br><\/div><div class="gm-sig">[\s\S]*$/, '').replace(/<div class="gm-sig">[\s\S]*$/, '');
    templates.push({ id: uid('tp'), name, subject: c.m.subject, html: body });
    saveTemplates();
    toast(`Saved as template “${name}”.`);
  }

  // Help me write: the text comes from writeFromPrompt() / suggestReply() (see WRITING HELP).
  function setBody(c, text) {
    const ed = editorOf(c), sig = ed.querySelector('.gm-sig');
    ed.innerHTML = textToHtml(text) + (sig ? `<div><br></div>${sig.outerHTML}` : '');
    if (c.source) cq(c, '.gc-source').value = ed.innerHTML;
    dirty(c);
  }
  function aiCreate(c) {
    const prompt = cq(c, '.gc-ai-prompt').value.trim();
    if (!prompt) { cq(c, '.gc-ai-prompt').focus(); return; }
    const a = accounts.find(x => x.email === c.m.from.email) || accounts[0];
    const first = c.m.to[0] ? firstName(c.m.to[0]) : '';
    const out = writeFromPrompt(prompt, { name: first, tone: cq(c, '.gc-ai-tone').value, length: cq(c, '.gc-ai-length').value, sender: a.signature && settings.autoSignature ? '' : a.name });
    setBody(c, out.text);
    if (standalone(c) && !cq(c, '.gc-subject').value.trim()) { cq(c, '.gc-subject').value = out.subject; updateComposer(c); }
    cq(c, '.gc-ai').hidden = true;
    toast('Draft written. Read it over before you send.');
  }
  function aiReply(c) {
    const inbound = [...shown(c.t)].reverse().find(m => !m.out);
    if (!inbound) { toast('There is no message to reply to yet.'); return; }
    const lead = leadByEmail(inbound.from.email), a = accounts.find(x => x.email === c.m.from.email) || accounts[0];
    const line = suggestReply({ kind: 'email', text: textOf(inbound.html), lead });
    setBody(c, replyText(line, firstName(inbound.from.email), a));
    cq(c, '.gc-ai').hidden = true;
  }
  const replyText = (line, first, a) => `Hi ${first || 'there'},\n\n${line}${a.signature && settings.autoSignature ? '' : `\n\nBest,\n${a.name}`}`;

  // ── SMALL PANELS (link, emoji, photo, colors) ──
  function openPanel(c, kind) {
    const p = cq(c, '.gc-panel');
    if (c.panel === kind) { closePanel(c); return; }
    saveRange(c);
    c.panel = kind;
    if (kind === 'link') {
      const sel = c.range ? c.range.toString() : '';
      p.innerHTML = `<div class="gc-pform"><label>Text to display<input class="gc-link-text" value="${esc(sel)}"></label><label>Web address (URL)<input class="gc-link-url" placeholder="https://"></label>
        <div class="gc-pfoot"><button class="gm-btn" data-c="panel-close">Cancel</button><button class="gm-btn primary" data-c="link-ok">Insert</button></div></div>`;
    } else if (kind === 'emoji') {
      p.innerHTML = `<div class="gc-emoji">${EMOJIS.map(e => `<button data-emoji="${e}" title="${e}">${e}</button>`).join('')}</div>`;
    } else if (kind === 'photo') {
      p.innerHTML = `<div class="gc-pform"><div class="gc-radio"><label><input type="radio" name="gcPhoto${c.m.id}" value="inline" checked> Inside the email</label><label><input type="radio" name="gcPhoto${c.m.id}" value="attach"> As attachment</label></div>
        <button class="gm-btn" data-c="photo-upload">${mi('upload', 18)}Upload from computer</button>
        <label>Or web address (URL)<input class="gc-photo-url" placeholder="https://…/picture.jpg"></label>
        <div class="gc-pfoot"><button class="gm-btn" data-c="panel-close">Cancel</button><button class="gm-btn primary" data-c="photo-url">Insert</button></div></div>`;
    } else {
      const list = kind === 'color' ? TEXT_COLORS : BG_COLORS;
      p.innerHTML = `<div class="gc-phead">${kind === 'color' ? 'Text color' : 'Highlight color'}</div><div class="gc-swatches">${list.map(col => `<button data-swatch="${col}" style="background:${col}" title="${col}" aria-label="${col}"></button>`).join('')}</div>`;
    }
    p.hidden = false;
    const first = p.querySelector('input:not([type=radio])');
    if (first && kind === 'link') (first.value ? p.querySelector('.gc-link-url') : first).focus();
  }
  function closePanel(c) { c.panel = ''; cq(c, '.gc-panel').hidden = true; }

  // ── RECIPIENTS ──
  function contacts() {
    const map = new Map();
    leads.forEach(l => l.emails.forEach(e => map.set(e, `${fullName(l)} · ${l.company}`)));
    threads.forEach(t => t.msgs.forEach(m => [m.from.email, ...m.to, ...m.cc].forEach(e => { if (!mine(e) && !map.has(e)) map.set(e, m.from.email === e ? m.from.name : ''); })));
    return [...map].map(([email, name]) => ({ email, name }));
  }
  function addAddrs(c, key, text) {
    const list = String(text).split(/[,;\s]+/).map(x => x.trim().replace(/^<|>$/g, '').toLowerCase()).filter(Boolean);
    list.forEach(a => { if (!c.m[key].includes(a)) c.m[key].push(a); });
    const input = cq(c, `[data-chip="${key}"]`);
    if (input) input.value = '';
    renderChips(c, key);
    if (list.length) dirty(c);
  }
  function suggestAddrs(c, input) {
    const q = input.value.trim().toLowerCase();
    if (!q) { if (popAnchor === input) closePop(); return; }
    const found = contacts().filter(x => (x.email + ' ' + x.name).toLowerCase().includes(q) && !c.m[input.dataset.chip].includes(x.email)).slice(0, 6);
    if (!found.length) { if (popAnchor === input) closePop(); return; }
    openPop(input, found.map(x => ({ label: x.name ? `${x.name} <${x.email}>` : x.email, run: () => { addAddrs(c, input.dataset.chip, x.email); input.focus(); } })), { list: true });
  }

  // ── COMPOSER EVENTS ──
  function scheduleItems(c) {
    return [
      { label: 'Schedule send' },
      ...[['Tomorrow morning', dayAt(1, 8)], ['Tomorrow afternoon', dayAt(1, 13)], ['Monday morning', nextWeekday(1, 8)]].map(([label, when]) => ({ icon: 'clock', label: `${label} · ${fmtWhen(when)}`, run: () => schedule(c, when) })),
      { icon: 'calendar', label: 'Pick date & time…', run: () => pickTime('Schedule send', when => schedule(c, when)) }
    ];
  }
  function bindComposer(c) {
    const ed = editorOf(c), src = cq(c, '.gc-source');
    ed.addEventListener('input', () => dirty(c));
    ed.addEventListener('keyup', () => saveRange(c));
    ed.addEventListener('mouseup', () => saveRange(c));
    ed.addEventListener('paste', e => handlePaste(c, e));
    src.addEventListener('input', () => dirty(c));
    c.root.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); c.root.classList.add('drop'); } });
    c.root.addEventListener('dragleave', e => { if (!c.root.contains(e.relatedTarget)) c.root.classList.remove('drop'); });
    c.root.addEventListener('drop', e => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      c.root.classList.remove('drop');
      if (e.target.closest('.gc-editor')) { const r = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY); if (r) c.range = r; }
      addFiles(c, [...e.dataTransfer.files], !!e.target.closest('.gc-editor'));
    });
    // The formatting bar must not take the cursor away from the text being formatted.
    c.root.addEventListener('mousedown', e => { if (e.target.closest('.gc-fb, .gc-panel button, [data-swatch], [data-emoji]')) e.preventDefault(); });
    c.root.addEventListener('change', e => {
      const f = e.target.dataset.f;
      if (f === 'font') exec(c, 'fontName', e.target.value);
      else if (f === 'size') exec(c, 'fontSize', e.target.value);
      else if (e.target.classList.contains('gc-attach-input')) { addFiles(c, [...e.target.files]); e.target.value = ''; }
      else if (e.target.classList.contains('gc-photo-input')) {
        const inline = (c.root.querySelector(`input[name="gcPhoto${c.m.id}"]:checked`) || {}).value !== 'attach';
        addFiles(c, [...e.target.files], inline);
        e.target.value = '';
        closePanel(c);
      }
    });
    c.root.addEventListener('input', e => {
      if (e.target.classList.contains('gc-subject')) { updateComposer(c); dirty(c); }
      else if (e.target.dataset.chip) suggestAddrs(c, e.target);
    });
    c.root.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(c); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && e.target === ed) { e.preventDefault(); openPanel(c, 'link'); return; }
      if (e.key === 'Escape' && c.panel) { e.stopPropagation(); closePanel(c); return; }
      const input = e.target.dataset && e.target.dataset.chip ? e.target : null;
      if (!input) return;
      const key = input.dataset.chip;
      if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && input.value.trim())) {
        if (!input.value.trim()) return;
        e.preventDefault();
        const first = popAnchor === input ? popItems.find(i => i.run) : null;
        closePop();
        if (first && e.key === 'Enter') first.run(); else addAddrs(c, key, input.value);
      } else if (e.key === 'Backspace' && !input.value && c.m[key].length) { c.m[key].pop(); renderChips(c, key); cq(c, `[data-chip="${key}"]`).focus(); dirty(c); }
    });
    c.root.addEventListener('focusout', e => {
      const input = e.target.dataset && e.target.dataset.chip ? e.target : null;
      if (input && input.value.trim() && popAnchor !== input) addAddrs(c, input.dataset.chip, input.value);
    });
    c.root.addEventListener('click', e => {
      const fb = e.target.closest('[data-f]');
      if (fb && fb.tagName === 'BUTTON') { format(c, fb.dataset.f); return; }
      const sw = e.target.closest('[data-swatch]');
      if (sw) {
        exec(c, c.panel === 'color' ? 'foreColor' : 'hiliteColor', sw.dataset.swatch);
        cq(c, `[data-bar="${c.panel}"]`).style.background = sw.dataset.swatch;
        closePanel(c);
        return;
      }
      const emo = e.target.closest('[data-emoji]');
      if (emo) { exec(c, 'insertText', emo.dataset.emoji); return; }
      const b = e.target.closest('[data-c]');
      if (!b) return;
      const act = b.dataset.c;
      switch (act) {
        case 'head': if (c.min) { c.min = false; updateComposer(c); } break;
        case 'min': c.min = !c.min; updateComposer(c); break;
        case 'full': c.full = !c.full; c.min = false; updateComposer(c); break;
        case 'close': closeComposer(c); break;
        case 'popout': popOut(c); break;
        case 'show-cc': case 'show-bcc': { const k = act.slice(5); cq(c, `[data-row="${k}"]`).hidden = false; cq(c, `[data-chip="${k}"]`).focus(); break; }
        case 'unchip': c.m[b.dataset.key].splice(Number(b.dataset.i), 1); renderChips(c, b.dataset.key); dirty(c); break;
        case 'unfile': { const [f] = c.m.files.splice(Number(b.dataset.i), 1); renderAttachments(c); dirty(c); if (c.attached) setTimeout(() => dropFiles([f]), 0); break; }
        case 'from':
          if (popAnchor === b) { closePop(); break; }
          openPop(b, shownAccounts().map(a => ({ label: `${a.name} <${a.email}>`, cls: a.email === c.m.from.email ? 'selected' : '', run: () => setFrom(c, a) })), { list: true });
          break;
        case 'quote': insertHtml(c, `<div><br></div>${c.m.quote}`); c.m.quote = ''; updateComposer(c); break;
        case 'send': send(c); break;
        case 'schedule': if (popAnchor === b) closePop(); else openPop(b, scheduleItems(c), { list: true }); break;
        case 'fmt': c.fmt = !c.fmt; updateComposer(c); break;
        case 'attach': cq(c, '.gc-attach-input').click(); break;
        case 'link': case 'emoji': case 'photo': openPanel(c, act); break;
        case 'panel-close': closePanel(c); break;
        case 'link-ok': {
          const url = cq(c, '.gc-link-url').value.trim(), text = cq(c, '.gc-link-text').value.trim() || url;
          if (!url) { cq(c, '.gc-link-url').focus(); break; }
          const href = /^(https?:|mailto:|tel:)/i.test(url) ? url : 'https://' + url;
          closePanel(c);
          insertHtml(c, `<a href="${esc(href)}">${esc(text)}</a>`);
          break;
        }
        case 'photo-upload': cq(c, '.gc-photo-input').click(); break;
        case 'photo-url': {
          const url = cq(c, '.gc-photo-url').value.trim();
          if (!/^https?:\/\//i.test(url)) { cq(c, '.gc-photo-url').focus(); break; }
          closePanel(c);
          insertHtml(c, `<img src="${esc(url)}" alt="" style="max-width:100%">`);
          break;
        }
        case 'sig': insertSignature(c); break;
        case 'tpl':
          if (popAnchor === b) { closePop(); break; }
          openPop(b, [
            ...(templates.length ? templates.map(tp => ({ icon: 'note', label: tp.name, run: () => insertTemplate(c, tp) })) : [{ label: 'No templates yet' }]),
            { icon: 'plus', label: 'Save this email as a template', run: () => saveAsTemplate(c) },
            { icon: 'note', label: 'Manage templates', run: () => openSettings('templates') }
          ], { list: true });
          break;
        case 'ai': { const box = cq(c, '.gc-ai'); box.hidden = !box.hidden; if (!box.hidden) cq(c, '.gc-ai-prompt').focus(); break; }
        case 'ai-cancel': cq(c, '.gc-ai').hidden = true; break;
        case 'ai-create': aiCreate(c); break;
        case 'ai-reply': aiReply(c); break;
        case 'track': c.m.tracked = !c.m.tracked; updateComposer(c); dirty(c); toast(c.m.tracked ? 'Tracking is on for this email.' : 'Tracking is off for this email.'); break;
        case 'more':
          if (popAnchor === b) { closePop(); break; }
          openPop(b, [
            { icon: c.plain ? 'check' : 'file', label: 'Plain text mode', run: () => { c.plain = !c.plain; if (c.plain) { if (c.source) toggleSource(c); editorOf(c).innerHTML = textToHtml(editorOf(c).innerText); } updateComposer(c); dirty(c); } },
            { icon: c.source ? 'check' : 'note', label: 'Edit HTML code', run: () => toggleSource(c) },
            { icon: ed.spellcheck ? 'check' : 'note', label: 'Check spelling', run: () => { ed.spellcheck = !ed.spellcheck; ed.blur(); ed.focus(); } }
          ], { list: true });
          break;
        case 'discard': discard(c); break;
      }
    });
  }

  // ── WINDOWS: SETTINGS AND DATE PICKER ──
  const dialogEl = document.createElement('div');
  dialogEl.className = 'gm-modal-back';
  dialogEl.hidden = true;
  const dlg = { kind: '', tab: 'general', pick: null, rule: null, tpl: null, sigAccount: '', status: '' };
  function showDialog(html, wide = false) {
    dialogEl.innerHTML = `<div class="gm-modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    dialogEl.hidden = false;
  }
  function closeDialog() {
    dlg.kind = '';
    dialogEl.hidden = true;
    dialogEl.innerHTML = '';
  }
  function pickTime(title, done) {
    const local = inputValue(Date.now() + 3600000).slice(0, 14) + '00';
    dlg.kind = 'pick';
    dlg.pick = done;
    showDialog(`<div class="gm-modal-head"><span>${esc(title)}</span><button class="gm-ib sm" data-x="close" title="Close" aria-label="Close">${mi('close', 20)}</button></div>
      <div class="gm-modal-body"><label class="gm-field">Date and time<input type="datetime-local" id="gmPickAt" value="${local}"></label><div class="gm-err" id="gmPickErr"></div></div>
      <div class="gm-modal-foot"><button class="gm-btn" data-x="close">Cancel</button><button class="gm-btn primary" data-x="pick">Save</button></div>`);
    dialogEl.querySelector('#gmPickAt').focus();
  }

  const TABS = [['general', 'General'], ['accounts', 'Accounts'], ['signature', 'Signature'], ['templates', 'Templates'], ['folders', 'Folders'], ['rules', 'Rules'], ['storage', 'Storage']];
  function openSettings(tab = 'general', extra = {}) {
    dlg.kind = 'settings';
    dlg.tab = tab;
    dlg.status = '';
    Object.assign(dlg, { rule: null, tpl: null }, extra);
    renderSettings();
  }
  const check = (id, on, label) => `<label class="gm-checkrow"><input type="checkbox" id="${id}"${on ? ' checked' : ''}> ${label}</label>`;
  const moveOptions = sel => [['', 'Keep in Inbox'], ['archive', 'Skip the Inbox (Archive it)'], ['spam', 'Send to Spam'], ['trash', 'Delete it'], ...folders.map(f => [f.id, `Move to “${f.name}”`])]
    .map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
  function ruleSummary(r) {
    const when = [r.from && `from “${r.from}”`, r.to && `to “${r.to}”`, r.subject && `subject has “${r.subject}”`, r.words && `has “${r.words}”`, r.hasAttachment && 'has attachment'].filter(Boolean).join(', ');
    const then = [r.folder && { archive: 'skip Inbox', spam: 'send to Spam', trash: 'delete' }[r.folder] || (r.folder && `move to ${viewName(r.folder)}`), r.star && 'star', r.read && 'mark read', r.important && 'mark important'].filter(Boolean).join(', ');
    return `When ${when} → ${then}`;
  }
  function settingsBody() {
    const t = dlg.tab;
    if (t === 'general') return `
      <div class="gm-set"><div class="gm-set-label">Undo send</div><div><label class="gm-field inline">Time to cancel after pressing Send
        <select id="gmUndo">${[5, 10, 20, 30].map(s => `<option value="${s}"${settings.undoSeconds === s ? ' selected' : ''}>${s} seconds</option>`).join('')}</select></label></div></div>
      <div class="gm-set"><div class="gm-set-label">Email tracking</div><div>${check('gmTrackDefault', settings.trackDefault, 'Track new emails by default')}<p class="gm-hint">A grey check means sent, green double checks mean opened. Tracking can be turned off in each email before sending.</p></div></div>`;
    if (t === 'accounts') return `
      <p class="gm-hint">The inbox shows mail for every address together. Pick an address in the sidebar to see only its mail. Each new email can be sent from any address.</p>
      <div class="gm-list">${shownAccounts().map((a, i) => `
        <div class="gm-list-row"><span class="gm-acct-dot" style="background:${a.color}">${esc(initialOf(a.email))}</span>
          <div class="gm-list-main"><input class="gm-inline-input" data-acct-name="${a.id}" value="${esc(a.name)}" aria-label="Name shown to people you email"><div class="gm-list-sub">${esc(a.email)}${i === 0 ? ' · default for new emails' : ''}</div></div>
          ${i ? `<button class="gm-btn" data-x="acct-default" data-id="${a.id}">Make default</button>` : ''}
          ${shownAccounts().length > 1 ? `<button class="gm-btn" data-x="acct-remove" data-id="${a.id}">Remove</button>` : ''}</div>`).join('') || '<p class="gm-hint">No email address yet. Add one below.</p>'}</div>
      <div class="gm-subhead">Add an email address</div>
      <div class="gm-form"><label class="gm-field">Name<input id="gmAcctName" value="${esc(person(user.name).full)}"></label><label class="gm-field">Email address<input id="gmAcctEmail" type="email" placeholder="name@company.com"></label>
        <div class="gm-field">Color<div class="gm-colors">${COLORS.map((col, i) => `<label><input type="radio" name="gmAcctColor" value="${col}"${i === accounts.length % COLORS.length ? ' checked' : ''}><i style="background:${col}"></i></label>`).join('')}</div></div>
        <div class="gm-err" id="gmAcctErr"></div><div><button class="gm-btn primary" data-x="acct-add">Add address</button></div></div>
      <p class="gm-hint">Receiving mail from a live mailbox needs a mail server connection, which is not set up yet.</p>`;
    if (t === 'signature') {
      const a = shownAccounts().find(x => x.id === dlg.sigAccount) || shownAccounts()[0];
      if (!a) return '<p class="gm-hint">Add an email address first.</p>';
      return `
        <div class="gm-form"><label class="gm-field">Signature for<select id="gmSigAccount">${shownAccounts().map(x => `<option value="${x.id}"${x === a ? ' selected' : ''}>${esc(x.email)}</option>`).join('')}</select></label>
        <div class="gm-field">Signature<div class="gm-rich" id="gmSigEdit" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Signature">${clean(a.signature)}</div></div>
        ${check('gmAutoSig', settings.autoSignature, 'Add the signature to new emails and replies automatically')}</div>`;
    }
    if (t === 'templates') {
      if (dlg.tpl) {
        const tp = dlg.tpl;
        return `<div class="gm-form"><label class="gm-field">Template name<input id="gmTplName" value="${esc(tp.name)}"></label><label class="gm-field">Subject<input id="gmTplSubject" value="${esc(tp.subject)}"></label>
          <div class="gm-field">Message<div class="gm-rich tall" id="gmTplBody" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Template message">${clean(tp.html)}</div></div>
          <div class="gm-err" id="gmTplErr"></div><div class="gm-row-btns"><button class="gm-btn" data-x="tpl-cancel">Cancel</button><button class="gm-btn primary" data-x="tpl-save">Save template</button></div></div>`;
      }
      return `<div class="gm-list">${templates.map(tp => `<div class="gm-list-row"><span class="gm-list-ic">${mi('template', 20)}</span><div class="gm-list-main"><b>${esc(tp.name)}</b><div class="gm-list-sub">${esc(tp.subject || textOf(tp.html).slice(0, 80))}</div></div>
          <button class="gm-btn" data-x="tpl-edit" data-id="${tp.id}">Edit</button><button class="gm-btn" data-x="tpl-delete" data-id="${tp.id}">Delete</button></div>`).join('') || '<div class="gm-list-empty">No templates yet. Save any email as a template from its Templates button, or create one here.</div>'}</div>
        <button class="gm-btn primary" data-x="tpl-new">${mi('add', 18)}New template</button>`;
    }
    if (t === 'folders') return `
      <p class="gm-hint">Drag folders in the sidebar to change their order. Drag emails onto a folder to move them.</p>
      <div class="gm-list">${folders.map(f => `<div class="gm-list-row"><span class="gm-fdot big" style="background:${f.color}"></span><div class="gm-list-main"><input class="gm-inline-input" data-folder-name="${f.id}" value="${esc(f.name)}" aria-label="Folder name"><div class="gm-list-sub">${threads.filter(x => x.folder === f.id).length} conversations</div></div>
        <button class="gm-btn" data-x="folder-delete" data-id="${f.id}">Delete</button></div>`).join('') || '<div class="gm-list-empty">No folders yet.</div>'}</div>
      <div class="gm-subhead">Create a folder</div>
      <div class="gm-form"><label class="gm-field">Folder name<input id="gmFolderName" placeholder="For example: Contracts"></label>
        <div class="gm-field">Color<div class="gm-colors">${COLORS.map((col, i) => `<label><input type="radio" name="gmFolderColor" value="${col}"${i === folders.length % COLORS.length ? ' checked' : ''}><i style="background:${col}"></i></label>`).join('')}</div></div>
        <div class="gm-err" id="gmFolderErr"></div><div><button class="gm-btn primary" data-x="folder-add">Create folder</button></div></div>`;
    if (t === 'rules') {
      if (dlg.rule) {
        const r = dlg.rule;
        return `<div class="gm-form"><div class="gm-subhead">When an email arrives that matches</div>
          <label class="gm-field">From<input id="gmRuleFrom" value="${esc(r.from)}"></label><label class="gm-field">To<input id="gmRuleTo" value="${esc(r.to)}"></label>
          <label class="gm-field">Subject<input id="gmRuleSubject" value="${esc(r.subject)}"></label><label class="gm-field">Has the words<input id="gmRuleWords" value="${esc(r.words)}"></label>
          ${check('gmRuleFiles', r.hasAttachment, 'Has attachment')}
          <div class="gm-subhead">Do this</div>
          <label class="gm-field">Where it goes<select id="gmRuleFolder">${moveOptions(r.folder)}</select></label>
          ${check('gmRuleStar', r.star, 'Star it')}${check('gmRuleRead', r.read, 'Mark it as read')}${check('gmRuleImportant', r.important, 'Mark it as important')}
          ${check('gmRuleNow', true, 'Also apply to matching conversations already here')}
          <div class="gm-err" id="gmRuleErr"></div><div class="gm-row-btns"><button class="gm-btn" data-x="rule-cancel">Cancel</button><button class="gm-btn primary" data-x="rule-save">Save rule</button></div></div>`;
      }
      return `<div class="gm-list">${rules.map(r => `<div class="gm-list-row"><span class="gm-list-ic">${mi('rule', 20)}</span><div class="gm-list-main">${esc(ruleSummary(r))}</div>
          <button class="gm-btn" data-x="rule-edit" data-id="${r.id}">Edit</button><button class="gm-btn" data-x="rule-delete" data-id="${r.id}">Delete</button></div>`).join('') || '<div class="gm-list-empty">No rules yet. Rules sort incoming email for you.</div>'}</div>
        <button class="gm-btn primary" data-x="rule-new">${mi('add', 18)}New rule</button>`;
    }
    const rows = threads.map(x => ({ t: x, size: JSON.stringify(x).length + x.msgs.reduce((n, m) => n + m.files.reduce((k, f) => k + f.size, 0), 0), files: x.msgs.reduce((n, m) => n + m.files.length, 0) })).sort((a, b) => b.size - a.size);
    const total = rows.reduce((n, r) => n + r.size, 0);
    return `
      <div class="gm-meter"><div class="gm-meter-top"><b>${esc(storageText)}</b><span>${storagePct ? `${(100 - storagePct).toFixed(storagePct > 99 ? 2 : 0)}% free` : ''}</span></div><i class="gm-meterbar big"><i style="width:${storagePct}%"></i></i>
        <p class="gm-hint">Measured by this browser for the whole CRM on this computer. Email uses about ${fmtBytes(total)} of it (${threads.length} conversations).</p></div>
      <div class="gm-list">${rows.map(({ t: x, size, files }) => `<div class="gm-list-row"><span class="gm-list-ic">${mi(files ? 'attach' : 'mail', 20)}</span>
          <div class="gm-list-main"><b>${esc(subjectOf(x))}</b><div class="gm-list-sub">${esc(viewName(x.folder === 'archive' ? 'all' : x.folder) || '')} · ${fmtListDate(threadAt(x))}${files ? ` · ${files} ${files === 1 ? 'file' : 'files'}` : ''}</div></div>
          <span class="gm-size">${fmtBytes(size)}</span><button class="gm-btn" data-x="store-delete" data-id="${x.id}">Delete</button></div>`).join('') || '<div class="gm-list-empty">No email saved.</div>'}</div>
      ${threads.length ? '<button class="gm-btn danger" data-x="store-clear">Delete all email</button>' : ''}`;
  }
  function renderSettings() {
    if (dlg.kind !== 'settings') return;
    const scroll = dialogEl.querySelector('.gm-modal-body') ? dialogEl.querySelector('.gm-modal-body').scrollTop : 0;
    showDialog(`<div class="gm-modal-head"><span>Email settings</span><span class="gm-status">${esc(dlg.status)}</span><button class="gm-ib sm" data-x="close" title="Close" aria-label="Close">${mi('close', 20)}</button></div>
      <div class="gm-tabs" role="tablist">${TABS.map(([id, label]) => `<button role="tab" class="gm-tab${dlg.tab === id ? ' on' : ''}" data-tab="${id}" aria-selected="${dlg.tab === id}">${label}</button>`).join('')}</div>
      <div class="gm-modal-body">${settingsBody()}</div>`, true);
    dialogEl.querySelector('.gm-modal-body').scrollTop = scroll;
  }
  function saved(text = 'Saved') { dlg.status = text; const s = dialogEl.querySelector('.gm-status'); if (s) s.textContent = text; }
  const val = id => (dialogEl.querySelector('#' + id) || {}).value?.trim() || '';
  const checked = id => !!(dialogEl.querySelector('#' + id) || {}).checked;
  const err = (id, text) => { dialogEl.querySelector('#' + id).textContent = text; };

  async function dialogClick(e) {
    if (e.target === dialogEl) { closeDialog(); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { openSettings(tab.dataset.tab); return; }
    const b = e.target.closest('[data-x]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.x) {
      case 'close': closeDialog(); break;
      case 'pick': {
        const when = fromInput(val('gmPickAt'));
        if (!when || when <= Date.now()) { err('gmPickErr', 'Pick a time in the future.'); break; }
        const done = dlg.pick;
        closeDialog();
        done(when);
        break;
      }
      case 'acct-add': {
        const email = val('gmAcctEmail').toLowerCase(), name = val('gmAcctName');
        if (!validAddr(email)) { err('gmAcctErr', 'Enter a valid email address.'); break; }
        if (mine(email)) { err('gmAcctErr', 'That address is already added.'); break; }
        accounts.push({ id: uid('a'), rep: user.name, name: name || email.split('@')[0], email, color: (dialogEl.querySelector('input[name=gmAcctColor]:checked') || {}).value || COLORS[0], signature: '' });
        saveAccounts();
        dlg.status = 'Address added';
        renderSettings();
        renderAll();
        break;
      }
      case 'acct-default': { const i = accounts.findIndex(a => a.id === id); accounts.unshift(...accounts.splice(i, 1)); saveAccounts(); dlg.status = 'Saved'; renderSettings(); renderAll(); break; }
      case 'acct-remove': {
        const a = account(id), count = threads.filter(x => x.account === id).length;
        if (!await ask({ title: `Remove ${a.email}?`, text: `${count ? `Its ${count} conversations are deleted from this CRM too. ` : ''}This can’t be undone.`, ok: 'Remove', danger: true })) break;
        accounts.splice(accounts.indexOf(a), 1);
        threads.filter(x => x.account === id).forEach(removeThread);
        if (ui.scope === id) ui.scope = 'all';
        saveAccounts();
        dlg.status = 'Address removed';
        renderSettings();
        renderAll();
        break;
      }
      case 'tpl-new': dlg.tpl = { id: '', name: '', subject: '', html: '' }; renderSettings(); dialogEl.querySelector('#gmTplName').focus(); break;
      case 'tpl-edit': dlg.tpl = { ...templates.find(x => x.id === id) }; renderSettings(); break;
      case 'tpl-cancel': dlg.tpl = null; renderSettings(); break;
      case 'tpl-save': {
        const name = val('gmTplName'), html = clean(dialogEl.querySelector('#gmTplBody').innerHTML);
        if (!name) { err('gmTplErr', 'Give the template a name.'); break; }
        if (!textOf(html) && !/<img/i.test(html)) { err('gmTplErr', 'Write the message for this template.'); break; }
        const tp = { id: dlg.tpl.id || uid('tp'), name, subject: val('gmTplSubject'), html };
        const i = templates.findIndex(x => x.id === tp.id);
        if (i >= 0) templates[i] = tp; else templates.push(tp);
        saveTemplates();
        dlg.tpl = null;
        dlg.status = 'Template saved';
        renderSettings();
        break;
      }
      case 'tpl-delete': templates.splice(templates.findIndex(x => x.id === id), 1); saveTemplates(); dlg.status = 'Template deleted'; renderSettings(); break;
      case 'folder-add': {
        const name = val('gmFolderName');
        if (!name) { err('gmFolderErr', 'Type a folder name.'); break; }
        if (folders.some(f => f.name.toLowerCase() === name.toLowerCase()) || Object.values(VIEWS).some(v => v.name.toLowerCase() === name.toLowerCase())) { err('gmFolderErr', 'A folder with that name already exists.'); break; }
        folders.push({ id: uid('fo'), name, color: (dialogEl.querySelector('input[name=gmFolderColor]:checked') || {}).value || COLORS[0] });
        saveFolders();
        dlg.status = 'Folder created';
        renderSettings();
        renderAll();
        break;
      }
      case 'folder-delete': {
        // Nothing is lost (its conversations stay in All Mail), so it goes at once with Undo.
        const f = folders.find(x => x.id === id), at = folders.indexOf(f);
        const inside = threads.filter(x => x.folder === id), ruled = rules.filter(r => r.folder === id);
        const apply = (folder, list) => { inside.forEach(x => { x.folder = folder; save(x); }); ruled.forEach(r => { r.folder = folder; }); saveRules(); list(); saveFolders(); renderSettings(); renderAll(); };
        apply('archive', () => folders.splice(at, 1));
        if (ui.view === id) ui.view = 'inbox';
        toast(`Folder “${f.name}” deleted.${inside.length ? ` Its ${inside.length} conversations are in All Mail.` : ''}`, [{ label: 'Undo', run: () => apply(id, () => folders.splice(Math.min(at, folders.length), 0, f)) }]);
        break;
      }
      case 'rule-new': dlg.rule = { id: '', from: '', to: '', subject: '', words: '', hasAttachment: false, folder: '', star: false, read: false, important: false }; renderSettings(); break;
      case 'rule-edit': dlg.rule = { ...rules.find(x => x.id === id) }; renderSettings(); break;
      case 'rule-cancel': dlg.rule = null; renderSettings(); break;
      case 'rule-save': {
        const r = { id: dlg.rule.id || uid('r'), from: val('gmRuleFrom'), to: val('gmRuleTo'), subject: val('gmRuleSubject'), words: val('gmRuleWords'), hasAttachment: checked('gmRuleFiles'),
          folder: val('gmRuleFolder'), star: checked('gmRuleStar'), read: checked('gmRuleRead'), important: checked('gmRuleImportant') };
        if (!hasCondition(r)) { err('gmRuleErr', 'Fill in at least one “matches” box.'); break; }
        if (!r.folder && !r.star && !r.read && !r.important) { err('gmRuleErr', 'Choose at least one thing to do.'); break; }
        const i = rules.findIndex(x => x.id === r.id);
        if (i >= 0) rules[i] = r; else rules.push(r);
        saveRules();
        let count = 0;
        if (checked('gmRuleNow')) threads.forEach(x => {
          if (gone(x) && r.folder !== 'spam' && r.folder !== 'trash') return;
          const m = [...shown(x)].reverse().find(y => !y.out);
          if (m && ruleMatches(r, x, m)) { applyRule(r, x, m); save(x); count++; }
        });
        dlg.rule = null;
        dlg.status = count ? `Rule saved · applied to ${count} ${count === 1 ? 'conversation' : 'conversations'}` : 'Rule saved';
        renderSettings();
        renderAll();
        break;
      }
      case 'rule-delete': rules.splice(rules.findIndex(x => x.id === id), 1); saveRules(); dlg.status = 'Rule deleted'; renderSettings(); break;
      case 'store-delete': {
        const x = find(id);
        if (!x || !await ask({ title: 'Delete for good?', text: `“${subjectOf(x)}” and its files are deleted to free the space. This can’t be undone.`, ok: 'Delete', danger: true })) break;
        if (ui.open === id) { if (composers.inline) destroy(composers.inline); ui.open = null; }
        removeThread(x);
        dlg.status = 'Deleted';
        renderAll();
        refreshStorage();
        break;
      }
      case 'store-clear': {
        if (!await ask({ title: 'Delete all email?', text: 'Every email and attached file saved in this CRM is deleted. This can’t be undone.', ok: 'Delete all', danger: true })) break;
        Object.values(composers).forEach(c => c && destroy(c));
        ui.open = null;
        threads = [];
        fileCache.clear();
        db.clear();
        changed();
        dlg.status = 'All email deleted';
        renderAll();
        refreshStorage();
        break;
      }
    }
  }
  function dialogInput(e) {
    const el = e.target;
    if (el.id === 'gmUndo') { settings.undoSeconds = Number(el.value); saveSettings(); saved(); }
    else if (el.id === 'gmTrackDefault') { settings.trackDefault = el.checked; saveSettings(); saved(); }
    else if (el.id === 'gmAutoSig') { settings.autoSignature = el.checked; saveSettings(); saved(); }
    else if (el.id === 'gmSigAccount') { dlg.sigAccount = el.value; renderSettings(); }
    else if (el.id === 'gmSigEdit') {
      const a = shownAccounts().find(x => x.id === dlg.sigAccount) || shownAccounts()[0];
      a.signature = clean(el.innerHTML);
      if (!textOf(a.signature) && !/<img/i.test(a.signature)) a.signature = '';
      saveAccounts();
      saved();
    } else if (el.dataset.acctName) {
      const a = account(el.dataset.acctName);
      if (el.value.trim()) { a.name = el.value.trim(); saveAccounts(); saved(); renderSoon(); }
    } else if (el.dataset.folderName) {
      const f = folders.find(x => x.id === el.dataset.folderName);
      if (el.value.trim()) { f.name = el.value.trim(); saveFolders(); saved(); renderSoon(); }
    }
  }
  dialogEl.addEventListener('click', dialogClick);
  dialogEl.addEventListener('input', dialogInput);
  dialogEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); if (dlg.kind) closeDialog(); }
    else if (e.key === 'Enter' && dlg.kind === 'pick') dialogEl.querySelector('[data-x="pick"]').click();
  });

  // ── ACTIONS ON CONVERSATIONS ──
  const targets = () => ui.selected.size ? [...ui.selected] : ui.open ? [ui.open] : [];
  function leaveIfGone(ids) {
    if (ui.open && ids.includes(ui.open)) {
      const t = find(ui.open);
      if (!t || !listThreads().includes(t)) closeThread();
    }
  }
  async function act(name, ids = targets(), value) {
    const list = ids.map(find).filter(Boolean);
    if (!list.length) return;
    const before = list.map(t => ({ t, folder: t.folder, deletedAt: t.deletedAt, snoozeUntil: t.snoozeUntil }));
    const undo = () => { before.forEach(b => { Object.assign(b.t, { folder: b.folder, deletedAt: b.deletedAt, snoozeUntil: b.snoozeUntil }); save(b.t); }); renderAll(); };
    const n = list.length, what = n === 1 ? 'Conversation' : `${n} conversations`;
    let message = '';
    if (name === 'delete' && list.every(t => t.folder === 'deleted')) {
      if (!await ask({ title: 'Delete for good?', text: `${n === 1 ? 'This conversation is' : `These ${n} conversations are`} deleted for good. This can’t be undone.`, ok: 'Delete', danger: true })) return;
      list.forEach(removeThread);
      ui.selected.clear();
      leaveIfGone(ids);
      toast(`${what} deleted for good.`);
      renderAll();
      return;
    }
    list.forEach(t => {
      if (name === 'archive') t.folder = 'archive';
      else if (name === 'spam') t.folder = 'spam';
      else if (name === 'notspam') t.folder = 'inbox';
      else if (name === 'delete') { t.folder = t.folder === 'trash' ? 'deleted' : 'trash'; t.deletedAt = Date.now(); }
      else if (name === 'read' || name === 'unread') t.msgs.forEach(m => { if (!m.out) m.read = name === 'read'; });
      else if (name === 'star' || name === 'unstar') t.starred = name === 'star';
      else if (name === 'important' || name === 'unimportant') t.important = name === 'important';
      else if (name === 'snooze') t.snoozeUntil = value;
      else if (name === 'move') {
        if (value === 'trash') t.deletedAt = Date.now();
        t.folder = value;
      } else if (name === 'discard') {
        const drafts = t.msgs.filter(m => m.draft);
        Object.values(composers).forEach(c => { if (c && drafts.includes(c.m)) destroy(c); });
        if (drafts.length === t.msgs.length) { removeThread(t); return; }
        t.msgs = t.msgs.filter(m => !m.draft);
        dropFiles(drafts.flatMap(m => m.files));
      }
      save(t);
    });
    if (name === 'archive') message = `${what} archived.`;
    else if (name === 'spam') message = `${what} marked as spam.`;
    else if (name === 'notspam') message = `${what} moved to Inbox.`;
    else if (name === 'delete') message = list[0].folder === 'deleted' ? `${what} moved to Recently deleted.` : `${what} moved to Trash.`;
    else if (name === 'snooze') message = `Snoozed until ${fmtWhen(value)}.`;
    else if (name === 'move') message = `${what} moved to ${viewName(value === 'archive' ? 'all' : value)}.`;
    else if (name === 'discard') message = n === 1 ? 'Draft discarded.' : 'Drafts discarded.';
    if (['archive', 'spam', 'notspam', 'delete', 'snooze', 'move'].includes(name)) { ui.selected.clear(); leaveIfGone(ids); }
    if (name === 'discard') { ui.selected.clear(); leaveIfGone(ids); }
    if (message) toast(message, name === 'discard' ? [] : [{ label: 'Undo', run: undo }]);
    renderAll();
  }
  function snoozeItems(ids) {
    const today = dayAt(0, 18) > Date.now() + 3600000 ? dayAt(0, 18) : Date.now() + 3 * 3600000;
    return [{ label: 'Snooze until…' }, ...[['Later today', today], ['Tomorrow', dayAt(1, 8)], ['This weekend', nextWeekday(6, 8)], ['Next week', nextWeekday(1, 8)]].map(([label, when]) => ({ icon: 'clock', label: `${label} · ${fmtWhen(when)}`, run: () => act('snooze', ids, when) })),
      { icon: 'calendar', label: 'Pick date & time…', run: () => pickTime('Snooze until', when => act('snooze', ids, when)) }];
  }
  function moveItems(ids) {
    return [{ label: 'Move to' }, { icon: 'mail', label: 'Inbox', run: () => act('move', ids, 'inbox') }, { icon: 'layers', label: 'All Mail (archive)', run: () => act('move', ids, 'archive') },
      ...folders.map(f => ({ icon: 'note', label: f.name, run: () => act('move', ids, f.id) })),
      { icon: 'x', label: 'Spam', run: () => act('move', ids, 'spam') }, { icon: 'x', label: 'Trash', run: () => act('move', ids, 'trash') },
      { icon: 'plus', label: 'Create new folder…', run: () => openSettings('folders') }];
  }
  function moreItems(ids) {
    const list = ids.map(find).filter(Boolean), t = list[0];
    const from = t && [...shown(t)].reverse().find(m => !m.out);
    return [
      list.some(x => !x.starred) ? { icon: 'check', label: 'Add star', run: () => act('star', ids) } : { icon: 'x', label: 'Remove star', run: () => act('unstar', ids) },
      list.some(x => !x.important) ? { icon: 'check', label: 'Mark as important', run: () => act('important', ids) } : { icon: 'x', label: 'Mark as not important', run: () => act('unimportant', ids) },
      ...(from ? [{ icon: 'copy', label: 'Filter messages like these', run: () => openSettings('rules', { rule: { id: '', from: from.from.email, to: '', subject: '', words: '', hasAttachment: false, folder: '', star: false, read: false, important: false } }) }] : [])
    ];
  }
  // The ⋮ menu over an open email: what its bar leaves out (spam, snooze, move), then the usual More items.
  function readMoreItems(ids) {
    const v = ui.query ? 'search' : ui.view, usual = v !== 'spam' && v !== 'trash' && v !== 'deleted';
    return [
      ...(usual ? [{ icon: 'x', label: 'Report spam', run: () => act('spam', ids) }, ...snoozeItems(ids)] : []),
      ...moveItems(ids),
      { label: 'More' }, ...moreItems(ids)
    ];
  }
  function menuFor(b, items) { if (popAnchor === b) closePop(); else openPop(b, items, { list: true }); }

  // ── MOVING AROUND ──
  function goView(id) {
    if (composers.inline) closeComposer(composers.inline);
    Object.assign(ui, { view: id, query: '', page: 0, open: null, drawer: false, chip: 'all' });
    ui.selected.clear();
    q$('gmSearch').value = '';
    render();
  }
  function openConversation(id) {
    const t = find(id);
    if (!t) return;
    const draftOnly = !shown(t).length;
    if (draftOnly) { const d = t.msgs.find(m => m.draft); if (d) openComposer(t, d); return; }
    if (composers.inline && composers.inline.t !== t) closeComposer(composers.inline);
    if (ui.scope !== 'all' && t.account !== ui.scope) ui.scope = 'all';
    if (!ui.query && !viewTest(ui.view)(t)) Object.assign(ui, { view: gone(t) ? t.folder : t.folder === 'inbox' ? 'inbox' : 'all', page: 0 });
    Object.assign(ui, { open: id, drawer: false });
    ui.expanded.clear();
    if (isUnread(t)) { t.msgs.forEach(m => { if (!m.out) m.read = true; }); save(t); }
    const draft = t.msgs.find(m => m.draft && !m.sending);
    if (draft && !composers.inline && !(composers.window && composers.window.m === draft)) composers.inline = makeComposer('inline', t, draft);
    render();
    const row = root.querySelector(`[data-t="${id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  function closeThread() {
    if (composers.inline) closeComposer(composers.inline);
    ui.open = null;
    render();
  }
  function stepThread(dir) {
    const list = listThreads(), i = list.findIndex(t => t.id === ui.open), next = list[i + dir];
    if (next) openConversation(next.id);
  }
  function runSearch(text) {
    ui.query = text.trim();
    Object.assign(ui, { page: 0, open: null, chip: 'all' });
    ui.selected.clear();
    render();
  }
  function setAdv(open) {
    q$('gmAdv').hidden = !open;
    q$('gmAdvBtn').setAttribute('aria-expanded', open);
    if (open) { renderAdv(); q$('gmAdv').querySelector('input').focus(); }
  }
  function setBell(open) {
    const fly = q$('gmFlyout');
    fly.hidden = !open;
    q$('gmBell').setAttribute('aria-expanded', open);
    renderBell();
    if (open) { settings.seenOpens = Date.now(); saveSettings(); setTimeout(renderBell, 1500); }
  }

  // ── SCREEN EVENTS ──
  let searchTimer = 0;
  root.addEventListener('input', e => {
    if (e.target.id === 'gmSearch') { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(e.target.value), 250); }
  });
  root.addEventListener('change', e => {
    if (e.target.id === 'gmSelAll') {
      const page = listThreads().slice(ui.page * PAGE, ui.page * PAGE + PAGE);
      page.forEach(t => e.target.checked ? ui.selected.add(t.id) : ui.selected.delete(t.id));
      renderList();
    } else if (e.target.matches('[data-sel]')) {
      const id = e.target.closest('[data-t]').dataset.t;
      e.target.checked ? ui.selected.add(id) : ui.selected.delete(id);
      renderList();
    }
  });
  root.addEventListener('keydown', e => {
    if (e.target.id === 'gmSearch' && e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value); e.target.blur(); return; }
    if (e.target.closest('.gm-adv') && e.key === 'Enter') { e.preventDefault(); q$('gmAdv').querySelector('[data-m="adv-search"]').click(); return; }
    const row = e.target.closest('[data-t], [data-view], [data-scope], .gm-msg.folded');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
  });
  root.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('.gm-row-check')) return;
    const chip = t.closest('[data-chip]');
    if (chip) { ui.chip = chip.dataset.chip; ui.page = 0; renderList(); return; }
    const nav = t.closest('[data-view]');
    if (nav) { goView(nav.dataset.view); return; }
    const scope = t.closest('[data-scope]');
    if (scope) { ui.scope = scope.dataset.scope; goView(ui.view); return; }
    const opened = t.closest('[data-open-t]');
    if (opened) { setBell(false); openConversation(opened.dataset.openT); return; }
    const folded = t.closest('.gm-msg.folded');
    if (folded) { ui.expanded.add(folded.dataset.msg); renderRead(); return; }
    const b = t.closest('[data-m]');
    const row = t.closest('[data-t]');
    if (!b) { if (row) openConversation(row.dataset.t); return; }
    const id = row ? row.dataset.t : ui.open, th = find(id);
    const a = b.dataset.m;
    switch (a) {
      case 'menu': if (ui.mode === 'compact') ui.drawer = !ui.drawer; else { settings.rail = !settings.rail; saveSettings(); } render(); break;
      case 'compose': ui.drawer = false; render(); compose(); break;
      case 'clear-search': q$('gmSearch').value = ''; runSearch(''); break;
      case 'adv': setAdv(q$('gmAdv').hidden); break;
      case 'adv-search': { const v = advValues(); setAdv(false); q$('gmSearch').value = advQuery(v); runSearch(q$('gmSearch').value); break; }
      case 'adv-filter': {
        const v = advValues();
        setAdv(false);
        openSettings('rules', { rule: { id: '', from: v.from, to: v.to, subject: v.subject, words: v.words, hasAttachment: v.files, folder: '', star: false, read: false, important: false } });
        break;
      }
      case 'bell': setBell(q$('gmFlyout').hidden); break;
      case 'settings': openSettings(); break;
      case 'storage': openSettings('storage'); refreshStorage(); break;
      case 'new-folder': openSettings('folders'); setTimeout(() => dialogEl.querySelector('#gmFolderName').focus(), 0); break;
      case 'add-account': openSettings('accounts'); setTimeout(() => dialogEl.querySelector('#gmAcctEmail').focus(), 0); break;
      case 'refresh': dueCheck(); render(); toast('Mail is up to date.'); break;
      case 'empty-folder': act('delete', listThreads().map(x => x.id)); break;
      case 'page-prev': ui.page--; renderList(); break;
      case 'page-next': ui.page++; renderList(); break;
      case 'selmenu': {
        const page = listThreads().slice(ui.page * PAGE, ui.page * PAGE + PAGE);
        const pick = fn => () => { ui.selected.clear(); page.filter(fn).forEach(x => ui.selected.add(x.id)); renderList(); };
        menuFor(b, [['All', () => true], ['None', () => false], ['Read', x => !isUnread(x)], ['Unread', isUnread], ['Starred', x => x.starred], ['Unstarred', x => !x.starred]].map(([label, fn]) => ({ label, run: pick(fn) })));
        break;
      }
      case 'viewmenu': {
        const splits = ui.mode === 'full' ? [{ label: 'Reading pane' }, ...[['none', 'No split'], ['vertical', 'Right of inbox'], ['horizontal', 'Below inbox']].map(([k, label]) => ({ label, cls: settings.split === k ? 'selected' : '', run: () => { settings.split = k; saveSettings(); render(); } }))] : [];
        menuFor(b, [...splits, { label: 'Density' }, ...[['default', 'Default'], ['comfortable', 'Comfortable'], ['compact', 'Compact']].map(([k, label]) => ({ label, cls: settings.density === k ? 'selected' : '', run: () => { settings.density = k; saveSettings(); render(); } }))]);
        break;
      }
      case 'star': th.starred = !th.starred; save(th); renderSoon(); if (ui.open === id) renderRead(); break;
      case 'read-star': act(th.starred ? 'unstar' : 'star', [ui.open]); break;
      case 'important': th.important = !th.important; save(th); renderSoon(); break;
      case 'row-archive': act('archive', [id]); break;
      case 'row-delete': act('delete', [id]); break;
      case 'row-read': act(isUnread(th) ? 'read' : 'unread', [id]); break;
      case 'row-snooze': menuFor(b, snoozeItems([id])); break;
      case 'act-archive': act('archive'); break;
      case 'act-spam': act('spam'); break;
      case 'act-notspam': act('notspam'); break;
      case 'act-delete': act('delete'); break;
      case 'act-discard': act('discard'); break;
      case 'act-read': act('read'); break;
      case 'act-unread': act('unread'); if (!ui.selected.size) closeThread(); break;
      case 'act-snoozemenu': menuFor(b, snoozeItems(targets())); break;
      case 'act-movemenu': menuFor(b, moveItems(targets())); break;
      case 'act-moremenu': menuFor(b, moreItems(targets())); break;
      case 'read-moremenu': menuFor(b, readMoreItems([ui.open])); break;
      case 'foldermenu': menuFor(b, folderItems()); break;
      case 'back': closeThread(); break;
      case 'unsnooze': { const x = find(ui.open); x.snoozeUntil = 0; x.folder = 'inbox'; save(x); toast('Moved back to Inbox.'); renderAll(); break; }
      case 'fold': { const msg = b.closest('[data-msg]'); if (msg && shown(find(ui.open)).length > 1 && !t.closest('button')) { ui.expanded.delete(msg.dataset.msg); renderRead(); } break; }
      case 'opens': ui.opensShown.has(b.dataset.msg) ? ui.opensShown.delete(b.dataset.msg) : ui.opensShown.add(b.dataset.msg); renderRead(); break;
      case 'cancel-schedule': {
        const x = find(ui.open), m = x.msgs.find(y => y.id === b.dataset.msg);
        Object.assign(m, { scheduledAt: 0, draft: true });
        save(x);
        toast('Send canceled. The email is back in Drafts.');
        if (!shown(x).length) { ui.open = null; render(); openComposer(x, m); } else reopen(x, m);
        renderAll();
        break;
      }
      case 'msg-reply': startInline('reply', shown(find(ui.open)).find(m => m.id === b.dataset.msg)); break;
      case 'reply': case 'replyall': case 'forward': startInline(a); break;
      case 'suggest': {
        const x = find(ui.open), last = shown(x)[shown(x).length - 1];
        startInline('reply');
        setBody(composers.inline, replyText(b.querySelector('span').textContent, firstName(last.from.email), account(x.account)));
        break;
      }
    }
  });

  // ── DRAG AND DROP ──
  // Drag emails onto a folder to move them. Drag folders up or down to change their order.
  const DROP_TARGETS = { inbox: 'inbox', all: 'archive', spam: 'spam', trash: 'trash', favorites: 'star' };
  let dragFolder = null;
  root.addEventListener('dragstart', e => {
    const row = e.target.closest('[data-t]'), nav = e.target.closest('[data-view]');
    if (row) {
      const ids = ui.selected.has(row.dataset.t) ? [...ui.selected] : [row.dataset.t];
      e.dataTransfer.setData('text/nv-threads', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
    } else if (nav) {
      dragFolder = { id: nav.dataset.view, list: nav.dataset.list };
      e.dataTransfer.setData('text/nv-folder', nav.dataset.view);
      e.dataTransfer.effectAllowed = 'move';
    }
  });
  root.addEventListener('dragend', () => { dragFolder = null; root.querySelectorAll('.drop, .drop-before, .drop-after').forEach(n => n.classList.remove('drop', 'drop-before', 'drop-after')); });
  const threadTarget = id => DROP_TARGETS[id] || (folders.some(f => f.id === id) ? id : null);
  root.addEventListener('dragover', e => {
    const nav = e.target.closest('[data-view]');
    if (!nav) return;
    const types = [...e.dataTransfer.types];
    root.querySelectorAll('.drop, .drop-before, .drop-after').forEach(n => { if (n !== nav) n.classList.remove('drop', 'drop-before', 'drop-after'); });
    if (types.includes('text/nv-threads') && threadTarget(nav.dataset.view)) { e.preventDefault(); nav.classList.add('drop'); }
    else if (types.includes('text/nv-folder') && dragFolder && dragFolder.list === nav.dataset.list && dragFolder.id !== nav.dataset.view) {
      e.preventDefault();
      const r = nav.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      nav.classList.toggle('drop-after', after);
      nav.classList.toggle('drop-before', !after);
    }
  });
  root.addEventListener('drop', e => {
    const nav = e.target.closest('[data-view]');
    if (!nav) return;
    e.preventDefault();
    const threadsData = e.dataTransfer.getData('text/nv-threads');
    if (threadsData) {
      const target = threadTarget(nav.dataset.view), ids = JSON.parse(threadsData);
      if (target === 'star') act('star', ids); else if (target) act('move', ids, target);
    } else if (dragFolder) {
      const after = nav.classList.contains('drop-after'), list = dragFolder.list === 'system' ? systemOrder : folders.map(f => f.id);
      const from = list.indexOf(dragFolder.id);
      list.splice(from, 1);
      list.splice(list.indexOf(nav.dataset.view) + (after ? 1 : 0), 0, dragFolder.id);
      if (dragFolder.list === 'system') saveOrder();
      else { const sorted = list.map(id => folders.find(f => f.id === id)); folders.splice(0, folders.length, ...sorted); saveFolders(); }
      renderSide();
    }
    root.querySelectorAll('.drop, .drop-before, .drop-after').forEach(n => n.classList.remove('drop', 'drop-before', 'drop-after'));
  });

  // Clicks outside the search card, the opens list or a composer's small panel close them.
  document.addEventListener('pointerdown', e => {
    Object.values(composers).forEach(c => { if (c && c.panel && !e.target.closest('.gc-panel, .gc-fmt, [data-c="link"], [data-c="emoji"], [data-c="photo"]')) closePanel(c); });
    if (!q$('gmAdv').hidden && !e.target.closest('.gm-adv, #gmAdvBtn')) setAdv(false);
    if (!q$('gmFlyout').hidden && !e.target.closest('#gmFlyout, #gmBell')) setBell(false);
  });

  // ── KEYBOARD SHORTCUTS (Email page) ──
  // c compose · / search · j k next and previous · u back · e archive · # delete · s star · r reply · a reply all · f forward
  function keydown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable="true"]') || dlg.kind) return false;
    const k = e.key, t = ui.open && find(ui.open);
    const run = fn => { e.preventDefault(); fn(); return true; };
    if (k === 'c') return run(() => compose());
    if (k === '/') return run(() => q$('gmSearch').focus());
    if (k === 'j' || k === 'k') return run(() => t ? stepThread(k === 'j' ? 1 : -1) : (listThreads()[0] && openConversation(listThreads()[0].id)));
    if (k === 'u' && t) return run(closeThread);
    if (k === 'e' && targets().length) return run(() => act('archive'));
    if (k === '#' && targets().length) return run(() => act('delete'));
    if (k === 's' && t) return run(() => act(t.starred ? 'unstar' : 'star', [t.id]));
    if (t && (k === 'r' || k === 'a' || k === 'f')) return run(() => startInline({ r: 'reply', a: 'replyall', f: 'forward' }[k]));
    return false;
  }
  // Escape closes the top-most mail piece. Returns true when it closed something.
  function escape() {
    if (dlg.kind) { closeDialog(); return true; }
    if (!q$('gmAdv').hidden) { setAdv(false); return true; }
    if (!q$('gmFlyout').hidden) { setBell(false); return true; }
    const c = [composers.window, composers.inline].find(x => x && x.root.contains(document.activeElement));
    if (c) { if (c.panel) closePanel(c); else closeComposer(c); return true; }
    if (ui.drawer) { ui.drawer = false; render(); return true; }
    return false;
  }

  // ── REDRAWING ──
  let soonFrame = 0, changeFrame = 0;
  function renderSoon() {
    cancelAnimationFrame(soonFrame);
    soonFrame = requestAnimationFrame(() => { renderSide(); renderList(); renderBell(); });
  }
  function renderAll() { render(); changed(); }
  function changed() {
    refreshStorage();
    cancelAnimationFrame(changeFrame);
    changeFrame = requestAnimationFrame(onMailChange);
  }

  // ── START ──
  document.body.append(dialogEl);
  // A draft being typed when the page closes is kept in quick storage too, because the mail database may not finish
  // writing while the page shuts down. It is moved back into the database the next time the CRM opens.
  addEventListener('pagehide', () => {
    const open = Object.values(composers).filter(c => c && c.attached && c.m.draft);
    open.forEach(saveDraft);
    if (open.length) store.write('nv.mail.unsaved', open.map(c => c.t));
  });
  const ready = (async () => {
    let loaded = null;
    try { loaded = await db.threads(); } catch { db.ok = false; }
    // The sample mail loads again when sample-data.js raises mailboxVersion: its addresses come back with their reps
    // and its sample conversations are replaced. Conversations started in the CRM are kept.
    const version = sample('mailboxVersion', 0);
    if (loaded && loaded.length) {
      threads = loaded;
      if (store.read('nv.mail.seeded', 0) !== version) {
        sample('mailAccounts', []).forEach(x => { const a = accounts.find(y => y.id === x.id); if (a) a.rep = x.rep; else accounts.push({ ...x }); });
        saveAccounts();
        const fresh = seedThreads(), ids = new Set(fresh.map(t => t.id));
        threads = [...threads.filter(t => !ids.has(t.id)), ...fresh];
        fresh.forEach(t => db.put(t));
        store.write('nv.mail.seeded', version);
      }
    } else if (!loaded || store.read('nv.mail.seeded', 0) !== version) {
      threads = seedThreads();
      if (loaded) { threads.forEach(t => db.put(t)); store.write('nv.mail.seeded', version); } else dispatchEvent(new Event('savefail'));
    }
    store.read('nv.mail.unsaved', []).forEach(t => {
      const i = threads.findIndex(x => x.id === t.id);
      if (i >= 0) threads[i] = t; else threads.push(t);
      db.put(t);
    });
    store.write('nv.mail.unsaved', null);
    // Tidy up: an email that was still inside its Undo window when the page closed goes back to Drafts, and old Trash moves on.
    const month = 30 * 86400000, now = Date.now();
    threads.forEach(t => {
      let dirtyThread = false;
      t.msgs.forEach(m => { if (m.sending) { Object.assign(m, { sending: false, draft: true }); dirtyThread = true; } });
      if (t.folder === 'trash' && now - t.deletedAt > month) { t.folder = 'deleted'; t.deletedAt = now; dirtyThread = true; }
      if (dirtyThread) db.put(t);
    });
    threads.filter(t => t.folder === 'deleted' && now - t.deletedAt > month).forEach(removeThread);
    loading = false;
    dueCheck();
    setInterval(dueCheck, 15000);
    render();
    changed();
  })();

  return {
    ready,
    // Puts the mail screen in a place on the page: 'full' for the Email page, 'compact' for Panel 3.
    // A new email being written in Panel 3 becomes a window when the mail screen moves to the Email page.
    mount(host, mode) {
      if (root.parentNode !== host) host.append(root);
      ui.mode = mode;
      ui.drawer = false;
      render();
      if (mode === 'full' && composers.window && composers.window.where === 'pane') moveComposer(composers.window);
    },
    compose,
    openThread: openConversation,
    keydown,
    escape,
    // Opens a conversation with a reply already typed in, ready to edit or send.
    replyWith(id, text) {
      openConversation(id);
      const t = find(id);
      if (!t || !ui.open) return;
      startInline('reply');
      const last = [...shown(t)].reverse().find(m => !m.out) || lastMsg(t);
      setBody(composers.inline, replyText(text, firstName(last.from.email), account(t.account)));
    },
    // Sends a reply right away (used by the quick reply in notifications). Returns false when there is nothing to reply to.
    quickReply(id, text) {
      const t = find(id);
      if (!t || !text.trim()) return false;
      const a = account(t.account), last = [...shown(t)].reverse().find(m => !m.out) || lastMsg(t);
      const m = replyDraft(t, 'reply', last);
      m.html = textToHtml(replyText(text.trim(), firstName(last.from.email), a)) + (settings.autoSignature && a.signature ? `<div><br></div>${sigHtml(a)}` : '') + `<div><br></div>${m.quote}`;
      Object.assign(m, { quote: '', draft: false, at: Date.now(), by: user.name });
      t.msgs.push(m);
      commit(t, m);
      return true;
    },
    // The latest inbound email of a conversation, for notifications.
    latest(id) {
      const t = find(id), m = t && [...shown(t)].reverse().find(x => !x.out);
      return m ? { from: m.from.email, subject: m.subject, text: textOf(m.html), at: m.at } : null;
    },
    // After My work / All reps changes: an address or conversation that is no longer shown is closed.
    refit() {
      if (!shownAccounts().some(a => a.id === ui.scope)) ui.scope = 'all';
      if (ui.open && !shownThreads().some(t => t.id === ui.open)) closeThread();
      render();
      changed();
    },
    // Every email that went out, for the Activity Log. by: who sent it (not saved by older versions). rep: the address's rep.
    sent() {
      return threads.filter(t => !gone(t)).flatMap(t => sentMsgs(t).map(m => ({ id: m.id, at: m.at, by: m.by, rep: account(t.account).rep, to: m.to[0] || '',
        subject: m.subject || '(no subject)', opens: m.tracked ? m.opens : [] })));
    },
    // The latest tracked email sent to any of a lead's addresses: when it was sent and every open, newest first.
    tracking(lead) {
      let best = null;
      shownThreads().forEach(t => { if (!gone(t)) sentMsgs(t).forEach(m => { if (m.tracked && [...m.to, ...m.cc, ...m.bcc].some(e => lead.emails.includes(e)) && (!best || m.at > best.at)) best = m; }); });
      return best && { subject: best.subject || '(no subject)', sent: best.at, opens: [...best.opens].sort((x, y) => y - x) };
    },
    // Inbox and Sent conversations for Panel 3's All tab.
    recent() {
      return shownThreads().filter(t => !gone(t) && shown(t).length && (VIEWS.inbox.test(t) || sentMsgs(t).length)).map(t => {
        const m = lastMsg(t), peer = m.out ? m.to[0] || '' : m.from.email, lead = leadByEmail(peer);
        return { id: t.id, at: threadAt(t), name: lead ? fullName(lead) : m.out ? peer : m.from.name, subject: subjectOf(t), out: m.out, unread: isUnread(t), peer, account: account(t.account).email, leadId: lead ? lead.id : null };
      });
    },
    // Conversations whose subject, people or words hold every word searched for, newest first (the top bar's search).
    find(q, limit) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return shownThreads().filter(t => !gone(t) && shown(t).length)
        .filter(t => { const text = [subjectOf(t), ...shown(t).flatMap(m => [m.from.name, m.from.email, ...m.to, textOf(m.html)])].join(' ').toLowerCase(); return words.every(w => text.includes(w)); })
        .sort((a, b) => threadAt(b) - threadAt(a)).slice(0, limit)
        .map(t => { const m = lastMsg(t); return { id: t.id, subject: subjectOf(t), who: m.out ? m.to[0] || '' : m.from.name, at: threadAt(t) }; });
    },
    unreadCount: () => shownThreads().filter(t => VIEWS.inbox.test(t) && isUnread(t)).length,
    // Email templates and the safe-HTML cleaner, for Campaign previews. openSettings opens this page's Settings on a tab.
    templates: () => templates,
    safeHtml: clean,
    openSettings,
    mailServer
  };
})();
