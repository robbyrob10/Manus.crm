// ── SCANNER ──
// The screen for a high-volume document scanner: drop box, the three scan settings, live progress, the results table,
// the OCR / rescan list, the scan audit and batch history. Only the screen lives here; the scanner engine is attached later.
//
// How the engine connects (nothing below scans, reads or unzips files by itself):
//   scanner.attach(engine)    engine = { start({ files, sourceType, sourceName, settings }), pause(), resume(), stop(), retryFailed(), runRescan(items) }
//   scanner.settings          the current { regularPages, ocrPages, minimumRevenue }, read at any time
//   scanner.update({ batchId, upload, progress })   upload and progress are merged in; a Batch ID never changes once set
//   scanner.upsertRows(rows)  adds a company row, or replaces the row that has the same id (it keeps its place)
//   scanner.setRescan(items) · scanner.setAudit(docs) · scanner.setHistory(batches)
//   scanner.shortName(name)   display name for a file: "ABC Funding August Statement.pdf" → "ABC Funding AUG"
//
// upload:   { status, sourceType: 'zip' | 'folder' | 'files', sourceName, filesPrepared, filesTotal, phaseText }
//           status: idle · accepted · unzipping · preparing · ready · scanning · paused · stopped · complete · error
// progress: { completed, total, regularScanned, skipped, ocrNeeded, failed, elapsed, eta (seconds), progress (0–1), activeLanes }
//           activeLanes: [{ laneId, originalName, displayName }]
// row:      { id, company, companyAlt, dba, owner, ownerAlt, revenue, statements: [{ period: 'SEP' | 'MTD', deposits, balance }],
//             phones, emails, dob, appDate, businessAddress, businessAddressAlt, applicationAddress, ein, bank, account,
//             mca: [{ company, payment, frequency, monthlyTotal }], dailyCashFlow }
//           "Alt" is the value on the statements when it is different from the application.
// rescan:   { id, originalName, displayName, company, method: 'regular' | 'ocr', reasons: [] }
// audit:    { id, document, company, type, text, ocr, pages, extraction, details, issue }
// history:  { batchId, at, source, files, leads, kept, skipped, failed, notes }
//
// The engine applies the revenue rule: keep a company when App Revenue is at least minimumRevenue,
// or when any statement's ending balance is over $15,000.
const scanner = (() => {
  const page = $('scanPage'), source = $('scanSource'), dialog = $('scanDialog'), menu = $('scanMenu');
  const more = $('scanMore'), moreSummary = more.querySelector('summary');
  const settings = { regularPages: 10, ocrPages: 2, minimumRevenue: 40000 };
  const freshUpload = () => ({ status: 'idle', sourceType: '', sourceName: '', filesPrepared: 0, filesTotal: 0, phaseText: '' });
  const freshProgress = () => ({ completed: 0, total: 0, regularScanned: 0, skipped: 0, ocrNeeded: 0, failed: 0, elapsed: 0, eta: null, progress: null, activeLanes: [] });
  const state = { batchId: '', upload: freshUpload(), progress: freshProgress(), rows: new Map(), rescan: [], audit: [], history: [] };
  const view = {
    reading: false, auditOpen: false, issuesOnly: false, sort: { key: 'document', dir: 1 },
    compact: false, wrap: false, numbers: true, freeze: true, menu: '', dialog: '', picks: new Map(), dialogNote: '', historyQuery: '',
    hidden: { results: new Set(), audit: new Set(), history: new Set() }, widths: { results: {}, audit: {}, history: {} }
  };
  let engine = null, frame = 0;
  const dirty = new Set();

  // ── FORMATS ──
  // Money is shown in full dollars, never shortened or rounded up: $85,000 · $1,200,000 · $15,000.01
  const dollars = n => n == null || n === '' ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
  // Under $90,000 the approval is $200,000. Otherwise it is App Revenue + $150,000, rounded up to the next $50,000.
  const approval = revenue => revenue == null ? null : revenue < 90000 ? 200000 : Math.ceil((revenue + 150000) / 50000) * 50000;
  const usDate = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : v || ''; };
  const clock = sec => {
    const s = Math.max(0, Math.round(sec)), h = Math.floor(s / 3600), pad = n => String(n).padStart(2, '0');
    return (h ? h + ':' : '') + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
  };
  const count = n => Number(n || 0).toLocaleString('en-US');
  const plural = (n, one, many = one + 's') => `${count(n)} ${n === 1 ? one : many}`;

  // Short display names. "ABC Funding Application 09-25-2026 Final Signed.pdf" → "ABC Funding App",
  // "… September Bank Statement 2026.pdf" → "… SEP", "… Month To Date Statement.pdf" → "… MTD". The original name is always kept.
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  function shortName(name) {
    const words = String(name).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_+/g, ' ').split(/\s+/).filter(Boolean);
    let end = 0, tag = '';
    for (let i = 1; i < words.length && !tag; i++) {
      const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
      const month = MONTHS.findIndex(m => w === m || w === m.slice(0, 3) || (m === 'september' && w === 'sept'));
      tag = w === 'application' || w === 'app' ? 'App'
        : w === 'mtd' || (w === 'month' && /^to$/i.test(words[i + 1] || '') && /^date$/i.test(words[i + 2] || '')) ? 'MTD'
        : month >= 0 ? MONTHS[month].slice(0, 3).toUpperCase() : '';
      if (!end && (tag || /^(bank|statement|statements|stmt)$/.test(w))) end = i;
    }
    const company = words.slice(0, end).join(' ').replace(/[\s,.–—-]+$/, '');
    return tag && company ? `${company} ${tag}` : words.join(' ');
  }
  const display = item => item.displayName || shortName(item.originalName || item.document || '');

  // ── RESULTS COLUMNS (exact order) ──
  // Each cell gives its plain text (tooltip and XLSX) and, when it needs color, its HTML.
  const pair = (main, other) => other && other !== main
    ? { text: `${main || ''} | ${other}`, html: `${esc(main || '')}<span class="sc-mm"><span class="sr-only"> statements show </span>${esc(other)}</span>` }
    : main || '';
  const joined = list => (list || []).filter(Boolean).join(' • ');
  const RESULT_COLS = [
    { key: 'n', label: '#', width: 44, cls: 'sc-num', cell: (r, i) => String(i + 1) },
    { key: 'company', label: 'Company', width: 210, cell: r => {
      const name = pair(r.company, r.companyAlt), text = typeof name === 'string' ? name : name.text;
      return r.dba ? { text: `${text} • ${r.dba}`, html: `${typeof name === 'string' ? esc(name) : name.html}<span class="sc-dba"> • ${esc(r.dba)}</span>` } : name;
    } },
    { key: 'owner', label: 'Owner / Applicant', width: 170, cell: r => pair(r.owner, r.ownerAlt) },
    { key: 'approval', label: 'Approval', width: 104, cls: 'sc-money', money: r => approval(r.revenue), cell: r => dollars(approval(r.revenue)) },
    { key: 'revenue', label: 'App Revenue', width: 110, cls: 'sc-money', money: r => r.revenue, cell: r => dollars(r.revenue) },
    { key: 'statements', label: 'Statements', width: 340, cell: r => {
      const list = r.statements || [], line = s => `${dollars(s.deposits) || '—'} | ${dollars(s.balance) || '—'}`;
      return { text: list.map(s => `${s.period} ${line(s)}`).join(' • '), html: list.map(s => `<b>${esc(s.period)}</b> ${line(s)}`).join(' • ') };
    } },
    { key: 'phone', label: 'Phone', width: 170, cell: r => joined((r.phones || []).map(fmtPhone)) },
    { key: 'email', label: 'Email', width: 210, cell: r => joined(r.emails) },
    { key: 'dob', label: 'DOB', width: 96, cell: r => usDate(r.dob) },
    { key: 'appDate', label: 'App Date', width: 96, cell: r => usDate(r.appDate) },
    { key: 'businessAddress', label: 'Business Address', width: 220, cell: r => pair(r.businessAddress, r.businessAddressAlt) },
    { key: 'applicationAddress', label: 'Application Address', width: 210, cell: r => r.applicationAddress || '' },
    { key: 'ein', label: 'EIN', width: 100, cell: r => r.ein || '' },
    { key: 'bank', label: 'Bank | Account', width: 210, cell: r => [r.bank, r.account].filter(Boolean).join(' | ') },
    { key: 'mca', label: 'MCA', width: 280, cell: r => joined((r.mca || []).map(m => [m.company || '—', dollars(m.payment) || '—', m.frequency || '—', dollars(m.monthlyTotal) || '—'].join(' | '))) },
    { key: 'cashFlow', label: 'Daily Cash Flow', width: 122, cls: 'sc-money', money: r => r.dailyCashFlow, cell: r => dollars(r.dailyCashFlow) }
  ];
  const AUDIT_COLS = [
    { key: 'document', label: 'Document', width: 250, sort: d => display(d).toLowerCase(), cell: d => ({ text: d.document || '', html: esc(display(d)) }) },
    { key: 'company', label: 'Company', width: 180, sort: d => (d.company || '').toLowerCase(), cell: d => d.company || '' },
    { key: 'type', label: 'Type', width: 100, sort: d => d.type || '', cell: d => d.type || '' },
    { key: 'text', label: 'Text', width: 72, sort: d => d.text || '', cell: d => d.text || '' },
    { key: 'ocr', label: 'OCR', width: 90, sort: d => d.ocr || '', cell: d => d.ocr || '' },
    { key: 'pages', label: 'Pages', width: 64, cls: 'sc-money', sort: d => Number(d.pages) || 0, cell: d => d.pages == null ? '' : String(d.pages) },
    { key: 'extraction', label: 'Extraction', width: 96, sort: d => d.extraction || '', cell: d => d.extraction || '' },
    { key: 'details', label: 'Details', width: 360, sort: d => (d.details || '').toLowerCase(), cell: d => d.details || '' }
  ];
  const HISTORY_COLS = [
    { key: 'batchId', label: 'Batch ID', width: 100, cell: b => b.batchId || '' },
    { key: 'at', label: 'Date', width: 150, cell: b => b.at ? `${showTime(b.at, { month: '2-digit', day: '2-digit', year: 'numeric' })} ${clockTime(b.at)}` : '' },
    { key: 'source', label: 'Source', width: 190, cell: b => b.source || '' },
    { key: 'files', label: 'Files', width: 64, cls: 'sc-money', cell: b => count(b.files) },
    { key: 'leads', label: 'Leads', width: 64, cls: 'sc-money', cell: b => count(b.leads) },
    { key: 'kept', label: 'Kept', width: 64, cls: 'sc-money', cell: b => count(b.kept) },
    { key: 'skipped', label: 'Skipped', width: 72, cls: 'sc-money', cell: b => count(b.skipped) },
    { key: 'failed', label: 'Failed', width: 64, cls: 'sc-money', cell: b => count(b.failed) },
    { key: 'notes', label: 'Notes', width: 260, cell: b => b.notes || '' }
  ];
  const COLS = { results: RESULT_COLS, audit: AUDIT_COLS, history: HISTORY_COLS };

  // ── TABLES ──
  // One builder for Results, Scan Audit and History: column widths the user can drag (kept while the page is open),
  // columns that can be hidden, and sorting where a column allows it. Widths are design sizes (at 16px to 1rem).
  const shownCols = grid => COLS[grid].filter(c => !view.hidden[grid].has(c.key) && !(grid === 'results' && c.key === 'n' && !view.numbers));
  const widthOf = (grid, c) => view.widths[grid][c.key] ?? c.width;
  const tableWidth = grid => rem(shownCols(grid).reduce((sum, c) => sum + widthOf(grid, c), 0));
  function renderGrid(table, grid, rows, rowAttr = () => '') {
    const cols = shownCols(grid), sortable = grid === 'audit';
    table.style.width = tableWidth(grid);
    table.style.setProperty('--sc-freeze', rem(cols[0].key === 'n' ? widthOf(grid, cols[0]) : 0));
    const head = c => {
      const sorted = sortable && view.sort.key === c.key;
      const label = sortable ? `<button class="sc-sort" type="button" data-sort="${c.key}">${c.label}${sorted ? ic('chevron', 10) : ''}</button>` : c.label;
      return `<th scope="col" class="c-${c.key}"${sortable ? ` aria-sort="${sorted ? (view.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"` : ''}>${label}`
        + `<span class="sc-rs" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize ${c.label} column" aria-valuemin="40" aria-valuemax="900" aria-valuenow="${widthOf(grid, c)}" data-rs="${c.key}"></span></th>`;
    };
    const cell = (c, r, i) => {
      const v = c.cell(r, i), text = typeof v === 'string' ? v : v.text;
      return `<td class="c-${c.key}${c.cls ? ' ' + c.cls : ''}"${text ? ` title="${esc(text)}"` : ''}>${typeof v === 'string' ? esc(v) : v.html}</td>`;
    };
    const empty = grid === 'results' && !rows.length
      ? `<tr class="sc-grid-empty"><td colspan="${cols.length}">Drop files above to begin scanning.</td></tr>` : '';
    table.innerHTML = `<colgroup>${cols.map(c => `<col data-col="${c.key}" style="width:${rem(widthOf(grid, c))}">`).join('')}</colgroup>`
      + `<thead><tr>${cols.map(head).join('')}</tr></thead>`
      + `<tbody>${empty}${rows.map((r, i) => `<tr${rowAttr(r)}>${cols.map(c => cell(c, r, i)).join('')}</tr>`).join('')}</tbody>`;
  }

  function resizeTo(handle, width) {
    const table = handle.closest('table'), grid = table.dataset.grid, key = handle.dataset.rs;
    const w = clamp(Math.round(width), 40, 900);
    view.widths[grid][key] = w;
    table.querySelector(`col[data-col="${key}"]`).style.width = rem(w);
    table.style.width = tableWidth(grid);
    if (key === 'n') table.style.setProperty('--sc-freeze', rem(w));
    handle.setAttribute('aria-valuenow', w);
  }
  function onResizeStart(e) {
    const handle = e.target.closest('[data-rs]');
    if (!handle || e.button !== 0) return;
    e.preventDefault();
    const table = handle.closest('table'), startX = e.clientX, scale = 16 / remPx();
    const startW = widthOf(table.dataset.grid, COLS[table.dataset.grid].find(c => c.key === handle.dataset.rs));
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('on');
    const move = ev => resizeTo(handle, startW + (ev.clientX - startX) * scale);
    const end = () => { handle.classList.remove('on'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  function onResizeKey(e) {
    const handle = e.target.closest('[data-rs]');
    if (!handle || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    resizeTo(handle, Number(handle.getAttribute('aria-valuenow')) + (e.key === 'ArrowRight' ? 16 : -16));
  }

  // ── STATUS ──
  const RUNNING = ['scanning', 'paused'];
  const PREPARING = ['unzipping', 'preparing', 'ready'];
  const status = () => state.upload.status;
  const can = action => !!engine && typeof engine[action] === 'function';
  const expanded = () => !['scanning', 'paused', 'stopped', 'complete'].includes(status());
  // While the box is busy (reading a folder, or the engine preparing files) it cannot take new files.
  const busy = () => view.reading || PREPARING.includes(status()) || (status() === 'accepted' && can('start'));
  const OFFLINE = 'The scanner is not connected yet.';
  const NOT_CONNECTED = OFFLINE + ' Nothing was scanned.';
  const SUPPORTED = /\.(zip|pdf|png|jpe?g|tiff?|webp|heic|bmp|gif)$/i;
  const folderPicker = 'webkitdirectory' in document.createElement('input');
  const acceptedWord = () => ({ zip: 'ZIP Accepted', folder: 'Folder Accepted', files: 'Files Accepted' }[state.upload.sourceType] || 'Files Accepted');

  function boxText() {
    const u = state.upload, s = u.status, total = u.filesTotal;
    if (s === 'idle') return ['Drop ZIP, folder, PDFs or images here or click anywhere to choose', 'ZIP, PDF, PNG, JPG and TIFF files'];
    if (s === 'error') return ['These files could not be used', u.phaseText || 'Choose a ZIP, a folder, PDFs or images.'];
    if (s === 'unzipping') return [`${acceptedWord()} • Unzipping…`, u.phaseText || (total ? `${count(u.filesPrepared)} / ${count(total)} files prepared` : 'Reading archive…')];
    if (s === 'ready') return [`${plural(total, 'file')} ready • Starting scan…`, u.sourceName];
    if (s === 'preparing') return [acceptedWord(), u.phaseText || (total ? `Preparing ${plural(total, 'file')}…` : 'Preparing files…')];
    if (view.reading) return [acceptedWord(), 'Reading files…'];
    const sub = u.phaseText || (u.sourceType === 'zip' ? 'Preparing archive…' : `Preparing ${plural(total, 'file')}…`);
    return [acceptedWord(), can('start') ? sub : `${u.sourceName}${total ? ' • ' + plural(total, 'file') : ''} • ${NOT_CONNECTED}`];
  }

  // ── RENDER ──
  function renderSource() {
    const s = status(), u = state.upload;
    source.classList.toggle('sc-compact', !expanded());
    if (expanded()) {
      const [title, sub] = boxText(), open = !busy();
      source.innerHTML = `
        <button class="sc-hit" type="button" data-act="choose"${open ? '' : ' disabled'}>
          ${mi('upload', 24)}
          <span class="sc-hit-title">${esc(title)}</span>
          <span class="sc-hit-sub">${esc(sub)}</span>
          ${busy() ? '<span class="sc-meter sc-wait" aria-hidden="true"><i></i></span>' : ''}
        </button>
        ${open && folderPicker ? '<button class="link-btn sc-folder" type="button" data-act="folder">Pick a folder instead</button>' : ''}`;
      return;
    }
    const running = RUNNING.includes(s), icon = u.sourceType === 'zip' ? 'archive' : u.sourceType === 'folder' ? 'move' : 'file';
    const label = { scanning: 'Scanning', paused: 'Paused', stopped: 'Stopped', complete: 'Complete' }[s];
    const btn = (act, text, cls = '') => `<button class="btn${cls}" type="button" data-act="${act}">${text}</button>`;
    source.innerHTML = `
      <div class="sc-strip">
        ${mi(icon, 16)}
        <span class="sc-strip-name" title="${esc(u.sourceName)}">${esc(u.sourceName || 'Batch')}</span>
        <span class="sc-chip" data-state="${s}">${label}</span>
        <div class="sc-ctrls">
          ${s === 'scanning' && can('pause') ? btn('pause', 'Pause') : ''}${s === 'paused' && can('resume') ? btn('resume', 'Resume') : ''}
          ${running && can('stop') ? btn('stop', 'Stop') : ''}
        </div>
      </div>`;
  }

  function renderProgress() {
    const box = $('scanProgress'), p = state.progress, s = status();
    box.hidden = expanded();
    if (box.hidden) return;
    const part = p.progress != null ? p.progress : p.total ? p.completed / p.total : null;
    const stat = (label, value) => `<span>${label} <b>${value}</b></span>`;
    box.innerHTML = `
      <div class="sc-stats">
        ${stat('Files', `${count(p.completed)} / ${count(p.total)}`)}${stat('Scanned', count(p.regularScanned))}${stat('Skipped', count(p.skipped))}${stat('OCR', count(p.ocrNeeded))}
        ${p.failed ? `<span>Failed <button class="link-btn sc-failed" type="button" data-act="failed" title="Show failed files">${count(p.failed)}</button></span>` : stat('Failed', 0)}
        <span>${clock(p.elapsed)}</span>${p.eta != null && RUNNING.includes(s) ? stat('ETA', clock(p.eta)) : ''}
      </div>
      <div class="sc-meter${part == null && s === 'scanning' ? ' sc-wait' : ''}" data-state="${s}" role="progressbar" aria-label="Scan progress"${part == null ? '' : ` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(part * 100)}"`}>
        <i${part == null ? '' : ` style="width:${clamp(part, 0, 1) * 100}%"`}></i>
      </div>`;
  }

  function renderHead() {
    const rows = state.rows.size, s = status(), n = state.rescan.length;
    const ocrOnly = state.rescan.every(x => x.method === 'ocr');
    $('scanTableSettings').hidden = !rows;
    $('scanRescanAction').hidden = !n;
    $('scanRescanAction').textContent = `${ocrOnly ? 'OCR needed' : 'Rescan needed'} · ${count(n)}`;
    $('scanRetryAction').hidden = RUNNING.includes(s) || !state.progress.failed;
    $('scanNewBatchAction').hidden = busy() || RUNNING.includes(s) && can('stop') || (!state.rows.size && !state.batchId);
    $('scanBatchMeta').hidden = !state.batchId;
    $('scanBatchMeta').textContent = state.batchId ? `Batch ${state.batchId}` : '';
    $('scanResultsHead').innerHTML = `
      <h2 class="panel-title" id="scanResultsTitle">Results</h2>
      ${rows ? `<span class="panel-count">${plural(rows, 'company', 'companies')}</span>` : ''}
      <div class="panel-tools sc-tools">
        ${rows && ['complete', 'stopped'].includes(s) ? '<button class="btn primary" type="button" data-act="xlsx">Download XLSX</button>' : ''}
      </div>`;
  }

  function renderResults() {
    const rows = [...state.rows.values()], table = $('scanTable');
    $('scanResultsWrap').hidden = false;
    table.classList.toggle('sc-compact-rows', view.compact);
    table.classList.toggle('sc-wrap', view.wrap);
    table.classList.toggle('sc-freeze', view.freeze);
    renderGrid(table, 'results', rows);
  }

  function renderAudit() {
    const box = $('scanAudit'), docs = state.audit, issues = docs.filter(d => d.issue).length;
    box.hidden = !docs.length;
    box.classList.toggle('open', view.auditOpen);
    if (!docs.length) return;
    $('scanAuditHead').innerHTML = `${ic('chevron', 12)}<span class="panel-title">Scan Audit</span><span class="panel-count">${plural(docs.length, 'document')}</span>${issues ? `<span class="sc-issues">Issues ${count(issues)}</span>` : ''}`;
    $('scanAuditHead').setAttribute('aria-expanded', view.auditOpen);
    $('scanAuditBody').hidden = !view.auditOpen;
    $('auditIssues').checked = view.issuesOnly;
    if (!view.auditOpen) return;
    const col = AUDIT_COLS.find(c => c.key === view.sort.key), list = docs.filter(d => !view.issuesOnly || d.issue);
    list.sort((a, b) => { const x = col.sort(a), y = col.sort(b); return (x < y ? -1 : x > y ? 1 : 0) * view.sort.dir; });
    renderGrid($('auditTable'), 'audit', list, d => d.issue ? ' class="sc-issue"' : '');
  }

  function render() {
    if (dirty.has('source')) renderSource();
    if (dirty.has('progress')) renderProgress();
    if (dirty.has('head')) renderHead();
    if (dirty.has('results')) renderResults();
    if (dirty.has('audit')) renderAudit();
    dirty.clear();
  }
  const mark = (...parts) => {
    parts.forEach(p => dirty.add(p));
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  };
  const announce = text => { $('scanLive').textContent = text; };
  // Every scan button goes to the engine. Before one is attached, the page says so instead of pretending.
  function request(action) {
    if (can(action)) engine[action]();
    else toast(OFFLINE);
  }

  // ── TAKING FILES ──
  function accept(files, sourceType, sourceName) {
    view.reading = false;
    const usable = files.filter(f => SUPPORTED.test(f.name));
    if (!usable.length) {
      Object.assign(state.upload, freshUpload(), { status: 'error', phaseText: files.length ? 'No ZIP, PDF or image files were found. Choose a ZIP, a folder, PDFs or images.' : 'That folder is empty.' });
      announce(state.upload.phaseText);
      mark('source');
      return;
    }
    const zip = usable.length === 1 && /\.zip$/i.test(usable[0].name);
    const type = zip ? 'zip' : sourceType, name = zip ? usable[0].name : sourceName || plural(usable.length, 'file');
    clearBatch();
    Object.assign(state.upload, { status: 'accepted', sourceType: type, sourceName: name, filesTotal: zip ? 0 : usable.length });
    announce(`${acceptedWord()}. ${can('start') ? '' : NOT_CONNECTED}`);
    mark('source', 'progress', 'head', 'results', 'audit');
    if (can('start')) engine.start({ files: usable, sourceType: type, sourceName: name, settings: { ...settings } });
  }
  // A dropped folder is read here so its files can be counted and handed over; nothing is opened or scanned.
  async function filesFromEntry(entry) {
    if (entry.isFile) return [await new Promise((ok, fail) => entry.file(ok, fail))];
    const reader = entry.createReader(), all = [];
    for (let batch; (batch = await new Promise((ok, fail) => reader.readEntries(ok, fail))).length;) all.push(...batch);
    return (await Promise.all(all.map(filesFromEntry))).flat();
  }
  async function onDrop(e) {
    e.preventDefault();
    source.classList.remove('sc-over');
    if (!expanded() || busy()) return;
    const entries = [...e.dataTransfer.items].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const folder = entries.find(x => x.isDirectory);
    if (!folder) { accept([...e.dataTransfer.files], 'files', ''); return; }
    Object.assign(state.upload, freshUpload(), { status: 'accepted', sourceType: 'folder', sourceName: folder.name });
    view.reading = true;
    announce('Folder Accepted. Reading files…');
    mark('source');
    try { accept((await Promise.all(entries.map(filesFromEntry))).flat(), 'folder', folder.name); }
    catch { view.reading = false; Object.assign(state.upload, { status: 'error', phaseText: 'The folder could not be read. Try choosing it instead.' }); mark('source'); }
  }

  function clearBatch() {
    state.batchId = '';
    state.upload = freshUpload();
    state.progress = freshProgress();
    state.rows.clear();
    state.rescan = [];
    state.audit = [];
    view.auditOpen = false;
  }
  async function newBatch() {
    if (state.rows.size && !await ask({ title: 'Start a new batch?', text: 'The results on screen are cleared. Download them first if you need them. This can’t be undone.', ok: 'Start new batch', danger: true })) return;
    clearBatch();
    announce('Ready for a new batch.');
    mark('source', 'progress', 'head', 'results', 'audit');
  }

  // ── SETTINGS ──
  // The three settings are always on screen. A value is used the moment it is valid; a bad value goes back on leaving the box.
  const FIELDS = [
    { el: $('setRegular'), key: 'regularPages', read: v => /^\d+$/.test(v.trim()) && Number(v) >= 1 ? Number(v) : null, show: n => String(n) },
    { el: $('setOcr'), key: 'ocrPages', read: v => /^\d+$/.test(v.trim()) && Number(v) >= 1 ? Number(v) : null, show: n => String(n) },
    { el: $('setRevenue'), key: 'minimumRevenue', read: v => { const t = v.replace(/[$,\s]/g, ''); return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : null; }, show: dollars }
  ];
  FIELDS.forEach(f => {
    f.el.value = f.show(settings[f.key]);
    f.el.addEventListener('input', () => { const n = f.read(f.el.value); f.el.setAttribute('aria-invalid', n == null); if (n != null) settings[f.key] = n; });
    f.el.addEventListener('change', () => { f.el.value = f.show(settings[f.key]); f.el.removeAttribute('aria-invalid'); });
  });

  // ── MENU: TABLE SETTINGS / COLUMNS ──
  function openMenu(grid, anchor) {
    view.menu = grid;
    const box = (key, label, on) => `<label class="sc-check"><input type="checkbox" data-opt="${key}"${on ? ' checked' : ''}>${label}</label>`;
    menu.innerHTML = (grid === 'results'
      ? `<div class="sc-menu-group"><div class="sc-menu-label">View</div>${box('compact', 'Compact', view.compact)}${box('wrap', 'Wrap cells', view.wrap)}${box('numbers', 'Row numbers', view.numbers)}${box('freeze', 'Freeze company', view.freeze)}</div>`
      : '')
      + `<div class="sc-menu-group"><div class="sc-menu-label">Columns</div>${COLS[grid].filter(c => c.key !== 'n' && c.key !== 'company' && c.key !== 'document')
        .map(c => box('col:' + c.key, c.label, !view.hidden[grid].has(c.key))).join('')}</div>`;
    const r = anchor.getBoundingClientRect();
    menu.setAttribute('aria-label', grid === 'results' ? 'Table settings' : 'Audit columns');
    menu.style.top = r.bottom + 6 + 'px';
    menu.style.right = document.documentElement.clientWidth - r.right + 'px';
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    menu.querySelector('input').focus();
  }
  function closeMenu(refocus = false) {
    if (!view.menu) return false;
    const anchor = page.querySelector(`[data-menu="${view.menu}"]`);
    view.menu = '';
    menu.hidden = true;
    if (anchor) { anchor.setAttribute('aria-expanded', 'false'); if (refocus) anchor.focus(); }
    return true;
  }
  function closeMore(refocus = false) {
    if (!more.open) return false;
    more.open = false;
    if (refocus) moreSummary.focus();
    return true;
  }
  more.addEventListener('toggle', () => moreSummary.setAttribute('aria-expanded', more.open));
  more.addEventListener('click', e => { if (e.target.closest('#scanMoreMenu button') && !e.target.closest('[data-menu]')) closeMore(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !more.open || view.menu || dialog.open) return;
    e.preventDefault();
    e.stopPropagation();
    closeMore(true);
  }, true);
  menu.addEventListener('change', e => {
    const opt = e.target.dataset.opt, grid = view.menu;
    if (opt.startsWith('col:')) { const key = opt.slice(4); view.hidden[grid][e.target.checked ? 'delete' : 'add'](key); }
    else view[opt] = e.target.checked;
    mark(grid === 'results' ? 'results' : 'audit');
  });
  document.addEventListener('pointerdown', e => {
    if (view.menu && !menu.contains(e.target) && !e.target.closest('[data-menu]')) closeMenu();
    if (more.open && !more.contains(e.target) && !menu.contains(e.target)) closeMore();
  });

  // ── DIALOG: OCR / RESCAN · HISTORY ──
  // Each rescan file starts selected, with its method and the page count from the always-visible settings.
  const pickOf = x => {
    if (!view.picks.has(x.id)) { const method = x.method === 'regular' ? 'regular' : 'ocr'; view.picks.set(x.id, { on: true, method, pages: method === 'ocr' ? settings.ocrPages : settings.regularPages }); }
    return view.picks.get(x.id);
  };
  function openDialog(kind) {
    view.dialog = kind;
    view.picks = new Map();
    renderDialog();
    dialog.showModal();
  }
  function renderDialog() {
    const head = title => `<div class="modal-head sc-dialog-head"><h2 id="scanDialogTitle">${title}</h2><button class="icon-btn" type="button" data-dlg="close" aria-label="Close">${ic('x', 14)}</button></div>`;
    if (view.dialog === 'history') {
      dialog.innerHTML = `${head('Batch history')}
        <div class="sc-dialog-tools"><input class="sc-search" id="historySearch" type="search" placeholder="Search Batch ID, date, source or notes" aria-label="Search batch history" value="${esc(view.historyQuery)}"></div>
        <div class="sc-grid-wrap sc-dialog-body scroll-always"><table class="sg" id="historyTable" data-grid="history"></table><p class="sc-empty" id="historyEmpty" hidden></p></div>`;
      renderHistory();
      return;
    }
    const list = state.rescan, name = x => esc(display(x));
    dialog.innerHTML = `${head(list.every(x => x.method === 'ocr') ? 'OCR Needed' : 'Rescan Needed')}
      <div class="sc-dialog-tools"><label class="sc-check"><input type="checkbox" data-pick="all">Select all</label><span class="sc-muted">${plural(list.length, 'file')}</span></div>
      <div class="sc-grid-wrap sc-dialog-body">
        <table class="sg sc-rescan">
          <thead><tr><th scope="col" class="c-pick"><span class="sr-only">Selected</span></th><th scope="col">File</th><th scope="col">Company</th><th scope="col">Reasons</th><th scope="col">Method</th><th scope="col">Pages</th></tr></thead>
          <tbody>${list.map(x => { const p = pickOf(x); return `
            <tr data-id="${esc(x.id)}">
              <td class="c-pick"><input type="checkbox" data-pick="one" aria-label="Rescan ${name(x)}"${p.on ? ' checked' : ''}></td>
              <td title="${esc(x.originalName || '')}">${name(x)}</td>
              <td>${esc(x.company || '')}</td>
              <td class="sc-tags">${(x.reasons || []).map(r => `<span class="sc-tag">${esc(r)}</span>`).join('')}</td>
              <td><select data-pick="method" aria-label="Method for ${name(x)}"><option value="regular"${p.method === 'regular' ? ' selected' : ''}>Regular</option><option value="ocr"${p.method === 'ocr' ? ' selected' : ''}>OCR</option></select></td>
              <td><input class="sc-pages" type="number" min="1" max="999" inputmode="numeric" data-pick="pages" value="${p.pages}" aria-label="Pages for ${name(x)}"></td>
            </tr>`; }).join('')}</tbody>
        </table>
      </div>
      <div class="modal-foot"><button class="btn" type="button" data-dlg="close">Cancel</button><button class="btn primary" type="button" data-dlg="run"></button></div>`;
    syncPicks();
  }
  // Keeps the Select all box and the Run Rescan count in step with the ticked files.
  function syncPicks() {
    const on = state.rescan.filter(x => pickOf(x).on).length, all = dialog.querySelector('[data-pick="all"]'), run = dialog.querySelector('[data-dlg="run"]');
    all.checked = on === state.rescan.length;
    all.indeterminate = on > 0 && on < state.rescan.length;
    run.textContent = `Run Rescan (${on})`;
    run.disabled = !on;
  }
  function renderHistory() {
    const q = view.historyQuery.trim().toLowerCase();
    const list = state.history.filter(b => !q || HISTORY_COLS.some(c => c.cell(b).toLowerCase().includes(q)));
    $('historyTable').hidden = !list.length;
    $('historyEmpty').hidden = !!list.length;
    $('historyEmpty').textContent = state.history.length ? 'No batches match your search.' : 'Finished batches show here.';
    if (list.length) renderGrid($('historyTable'), 'history', list);
  }
  function closeDialog() {
    if (!view.dialog) return false;
    dialog.close();
    return true;
  }
  dialog.addEventListener('close', () => { view.dialog = ''; dialog.innerHTML = ''; });
  dialog.addEventListener('click', e => {
    if (e.target === dialog) { closeDialog(); return; }
    const act = e.target.closest('[data-dlg]');
    if (!act) return;
    if (act.dataset.dlg === 'close') { closeDialog(); return; }
    if (!can('runRescan')) { toast('The scanner is not connected yet. Nothing was rescanned.'); return; }
    const items = state.rescan.filter(x => pickOf(x).on).map(x => { const { method, pages } = pickOf(x); return { ...x, method, pages }; });
    engine.runRescan(items);
    closeDialog();
    announce(`Sent ${plural(items.length, 'file')} to the scanner for rescan.`);
  });
  dialog.addEventListener('change', e => {
    const kind = e.target.dataset.pick;
    if (!kind) return;
    if (kind === 'all') {
      state.rescan.forEach(x => { pickOf(x).on = e.target.checked; });
      dialog.querySelectorAll('[data-pick="one"]').forEach(box => { box.checked = e.target.checked; });
    } else {
      const row = e.target.closest('tr'), p = view.picks.get(row.dataset.id);
      if (kind === 'one') p.on = e.target.checked;
      if (kind === 'method') { p.method = e.target.value; p.pages = p.method === 'ocr' ? settings.ocrPages : settings.regularPages; row.querySelector('[data-pick="pages"]').value = p.pages; }
      if (kind === 'pages') { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1) p.pages = n; else e.target.value = p.pages; }
    }
    syncPicks();
  });
  dialog.addEventListener('input', e => { if (e.target.id === 'historySearch') { view.historyQuery = e.target.value; renderHistory(); } });

  // ── XLSX DOWNLOAD ──
  // Builds a real .xlsx file in the browser from the results on screen (all 16 columns), then saves it to the computer.
  const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = bytes => { let c = 0xFFFFFFFF; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zipFiles(files) {
    const enc = new TextEncoder(), local = [], central = [];
    let offset = 0;
    files.forEach(({ name, text }) => {
      const n = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30 + n.length));
      [[0, 0x04034b50, 4], [4, 20, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, n.length, 2]]
        .forEach(([at, v, size]) => size === 4 ? head.setUint32(at, v, true) : head.setUint16(at, v, true));
      new Uint8Array(head.buffer).set(n, 30);
      const dir = new DataView(new ArrayBuffer(46 + n.length));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [14, 0x21, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, n.length, 2], [42, offset, 4]]
        .forEach(([at, v, size]) => size === 4 ? dir.setUint32(at, v, true) : dir.setUint16(at, v, true));
      new Uint8Array(dir.buffer).set(n, 46);
      local.push(head.buffer, data);
      central.push(dir.buffer);
      offset += 30 + n.length + data.length;
    });
    const size = central.reduce((sum, b) => sum + b.byteLength, 0), end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, offset, 4]]
      .forEach(([at, v, s]) => s === 4 ? end.setUint32(at, v, true) : end.setUint16(at, v, true));
    return new Blob([...local, ...central, end.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const xml = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colName = i => (i >= 26 ? colName(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + i % 26);
  function downloadXlsx() {
    const rows = [...state.rows.values()];
    // Money columns are saved as numbers with a $ format, so the sheet can add them up. Everything else is text.
    const text = (ref, v, style = 0) => `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    const num = (ref, v, money) => `<c r="${ref}"${money ? ` s="${Number.isInteger(v) ? 2 : 3}"` : ''}><v>${v}</v></c>`;
    const lines = [`<row r="1">${RESULT_COLS.map((c, i) => text(colName(i) + 1, c.label, 1)).join('')}</row>`,
      ...rows.map((r, n) => `<row r="${n + 2}">${RESULT_COLS.map((c, i) => {
        const ref = colName(i) + (n + 2), money = c.money ? c.money(r) : null, v = c.cell(r, n);
        return c.key === 'n' ? num(ref, n + 1) : money != null && money !== '' ? num(ref, Number(money), true) : text(ref, typeof v === 'string' ? v : v.text);
      }).join('')}</row>`)];
    const cols = RESULT_COLS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.round(widthOf('results', c) / 7)}" customWidth="1"/>`).join('');
    const NS = 'http://schemas.openxmlformats.org', head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const blob = zipFiles([
      { name: '[Content_Types].xml', text: `${head}<Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
      { name: '_rels/.rels', text: `${head}<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', text: `${head}<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', text: `${head}<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', text: `${head}<styleSheet xmlns="${NS}/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
      { name: 'xl/worksheets/sheet1.xml', text: `${head}<worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${lines.join('')}</sheetData></worksheet>` }
    ]);
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url;
    a.download = `${(state.batchId || 'Scan Results').replace(/[\\/:*?"<>|]/g, '-')}.xlsx`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce(`Saved ${a.download}`);
  }

  // ── CLICKS ──
  source.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    switch (act.dataset.act) {
      case 'choose': $('scanFiles').click(); break;
      case 'folder': $('scanFolder').click(); break;
      case 'pause': case 'resume': case 'stop': request(act.dataset.act); break;
      case 'retry': request('retryFailed'); break;
      case 'new': newBatch(); break;
    }
  });
  source.addEventListener('dragover', e => { e.preventDefault(); if (expanded() && !busy()) source.classList.add('sc-over'); });
  source.addEventListener('dragleave', e => { if (!source.contains(e.relatedTarget)) source.classList.remove('sc-over'); });
  source.addEventListener('drop', onDrop);
  // A file dropped anywhere else on this page is ignored instead of the browser opening it.
  page.addEventListener('dragover', e => e.preventDefault());
  page.addEventListener('drop', e => e.preventDefault());
  $('scanFiles').addEventListener('change', e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) accept(files, 'files', ''); });
  $('scanFolder').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) accept(files, 'folder', (files[0].webkitRelativePath || '').split('/')[0]);
  });

  page.addEventListener('click', e => {
    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) { view.menu === menuBtn.dataset.menu ? closeMenu() : (closeMenu(), openMenu(menuBtn.dataset.menu, menuBtn)); return; }
    const act = e.target.closest('#scanProgress [data-act], #scanResultsHead [data-act], #scanMoreMenu [data-act]');
    if (act) {
      if (act.dataset.act === 'rescan') openDialog('rescan');
      if (act.dataset.act === 'xlsx') downloadXlsx();
      if (act.dataset.act === 'failed') { Object.assign(view, { auditOpen: true, issuesOnly: true }); mark('audit'); $('scanAuditHead').focus(); }
      if (act.dataset.act === 'retry') request('retryFailed');
      if (act.dataset.act === 'new') newBatch();
      return;
    }
    const sort = e.target.closest('[data-sort]');
    if (sort) { view.sort = { key: sort.dataset.sort, dir: view.sort.key === sort.dataset.sort ? -view.sort.dir : 1 }; mark('audit'); }
  });
  $('scanAuditHead').addEventListener('click', () => { view.auditOpen = !view.auditOpen; mark('audit'); });
  $('auditIssues').addEventListener('change', e => { view.issuesOnly = e.target.checked; mark('audit'); });
  $('scanHistoryBtn').addEventListener('click', () => openDialog('history'));
  [page, dialog].forEach(el => { el.addEventListener('pointerdown', onResizeStart); el.addEventListener('keydown', onResizeKey); });

  // ── PUBLIC ──
  const api = {
    get settings() { return { ...settings }; },
    attach(e) { engine = e; mark('source'); },
    update({ batchId, upload, progress } = {}) {
      const before = status();
      if (batchId && !state.batchId) state.batchId = batchId;
      if (upload) Object.assign(state.upload, upload);
      if (progress) Object.assign(state.progress, progress);
      if (status() !== before) announce(expanded() ? boxText().join('. ') : `${status()[0].toUpperCase()}${status().slice(1)}.`);
      mark('source', 'progress', 'head');
    },
    upsertRows(rows) { rows.forEach(r => state.rows.set(r.id, r)); mark('head', 'results'); },
    setRescan(items) {
      state.rescan = [...items];
      if (view.dialog === 'rescan') { if (items.length) renderDialog(); else closeDialog(); }
      mark('head');
    },
    setAudit(docs) { state.audit = [...docs]; mark('audit'); },
    setHistory(batches) { state.history = [...batches]; if (view.dialog === 'history') renderHistory(); },
    shortName,
    // A scan is running only while the scanner engine is attached and scanning (or paused mid-batch).
    running: () => !!engine && RUNNING.includes(status()),
    escape: () => closeDialog() || closeMenu(true) || closeMore(true)
  };

  // ── START ──
  mark('source', 'progress', 'head', 'results', 'audit');
  return api;
})();
