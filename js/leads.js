// ── LEAD DATA ──

// Sample leads come from sample-data.js until real data is connected.
const seedLeads = sample('leads', []);

// Leads added in earlier versions saved phones as { label, num: '+1 (…)' } and emails as { label, addr },
// and had no status, rep or Touchpoints yet.
const fromStorage = l => ({
  status: 'NEW', rep: '', touch: {},
  ...l,
  phones: l.phones.map(p => p.type ? p : { type: p.label === 'Office' ? 'landline' : 'mobile', num: digitsOf(p.num).slice(-10) }),
  emails: l.emails.map(e => typeof e === 'string' ? e : e.addr)
});

const leads = [...store.read('nv.leads', []).map(fromStorage), ...seedLeads];
// Changes other pages make to a lead (a campaign updating its status or Touchpoints), kept in this browser.
const leadEdits = store.read('nv.leadEdits', {});
leads.forEach(l => Object.assign(l, leadEdits[l.id]));
function updateLead(id, fields) {
  const l = leads.find(x => x.id === id);
  if (!l) return;
  Object.assign(l, fields);
  leadEdits[id] = { ...leadEdits[id], ...fields };
  return store.write('nv.leadEdits', leadEdits);
}
const notesStore = store.read('nv.notes', {});
const activityStore = store.read('nv.activity', {});
const byRevenue = (a, b) => b.value - a.value;
// Reps see only their own leads. A lead with no rep shows only in the owner's All reps.
const myLeads = () => leads.filter(l => canSee(l.rep)).sort(byRevenue);
let selectedId = (myLeads()[0] || {}).id ?? null;
let query = '';
const pipelineFilters = { rep: '', status: '', sort: 'revenue' };

const fullName = l => `${l.first} ${l.last}`.trim();
const currentLead = () => leads.find(l => l.id === selectedId);
const lastTouch = l => Math.max(l.lastActive, (activityStore[l.id] || [])[0]?.at || 0);
const leadByEmail = addr => leads.find(l => l.emails.includes(String(addr).trim().toLowerCase())) || null;
function leadByNumber(number) {
  const d = digitsOf(number).slice(-10);
  return d.length < 10 ? null : leads.find(l => l.phones.some(p => p.num === d)) || null;
}

function logActivity(leadId, type, text) {
  if (!leads.some(l => l.id === leadId)) return;
  (activityStore[leadId] ||= []).unshift({ type, text, at: Date.now() });
  store.write('nv.activity', activityStore);
  if (leadId === selectedId) renderFeed();
  renderLeads();
}

const KINDS = { call: 'phone', sms: 'sms', wa: 'wa', email: 'mail', open: 'mailopen', meet: 'calendar', note: 'note', campaign: 'campaign', lead: 'userplus', remind: 'clock' };
const kindIcon = (kind, size = 11) => `<span class="kind" data-kind="${kind}">${ic(KINDS[kind], size)}</span>`;
const mapLink = address => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
function openLink(url, newTab = false) {
  const a = document.createElement('a');
  a.href = url;
  if (newTab) { a.target = '_blank'; a.rel = 'noopener'; }
  a.click();
}

// Time zone from the state in an address, like "San Francisco, CA 94103".
const ZONES = {
  'America/New_York': 'CT DC DE FL GA IN KY MA MD ME MI NC NH NJ NY OH PA RI SC VA VT WV',
  'America/Chicago': 'AL AR IA IL KS LA MN MO MS ND NE OK SD TN TX WI',
  'America/Denver': 'CO ID MT NM UT WY', 'America/Phoenix': 'AZ', 'America/Los_Angeles': 'CA NV OR WA',
  'America/Anchorage': 'AK', 'Pacific/Honolulu': 'HI'
};
const STATE_ZONE = Object.fromEntries(Object.entries(ZONES).flatMap(([zone, states]) => states.split(' ').map(st => [st, zone])));
const stateOf = address => ((address || '').match(/\b([A-Z]{2}) \d{5}/) || [])[1] || '';
const zoneOf = address => STATE_ZONE[stateOf(address)] || '';

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}
async function copyAndShow(text, el) {
  const cls = await copyText(text) ? 'copied' : 'copy-failed';
  el.classList.remove('copied', 'copy-failed');
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 1400);
}


// ── PANEL 1 · LEADS ──
function visibleLeads() {
  const q = query.trim().toLowerCase();
  const list = myLeads().filter(l => (!q || fullName(l).toLowerCase().includes(q) || l.company.toLowerCase().includes(q) || l.stage.includes(q))
    && (!pipelineFilters.rep || l.rep === pipelineFilters.rep) && (!pipelineFilters.status || l.status === pipelineFilters.status));
  if (pipelineFilters.sort === 'activity') return list.sort((a, b) => lastTouch(b) - lastTouch(a));
  if (pipelineFilters.sort === 'company') return list.sort((a, b) => a.company.localeCompare(b.company));
  return list.sort(byRevenue);
}

const trackIcon = l => {
  const e = mail.tracking(l);
  if (!e) return '';
  const n = e.opens.length;
  return `<button class="track${n ? ' opened' : ''}" data-track="${l.id}" aria-label="${n ? `Email opened ${n} ${n === 1 ? 'time' : 'times'}` : 'Email sent, not opened yet'}">${ic(n ? 'checks' : 'check', 12)}</button>`;
};

// Many updates can land in the same instant (a campaign logging several sends in a row).
// This redraws the list at most once per frame no matter how many times renderLeads() is called.
let leadsRenderQueued = false;
function renderLeads() {
  if (leadsRenderQueued) return;
  leadsRenderQueued = true;
  requestAnimationFrame(() => { leadsRenderQueued = false; renderLeadsNow(); });
}
// In the owner's All reps, each lead also shows whose it is.
function renderLeadsNow() {
  const list = visibleLeads(), allReps = isOwner && workScope === 'all';
  $('leadCount').textContent = `${list.length} ${list.length === 1 ? 'lead' : 'leads'}`;
  $('leadList').innerHTML = list.length
    ? list.map(l => `
      <div class="lead-row${l.id === selectedId ? ' selected' : ''}" data-id="${l.id}">
        ${avatarOf(l.id)}
        <div class="lead-company">${esc(l.company)}</div>
        <div class="lead-revenue">${money(l.value)}</div>
        <div class="lead-contact">${esc(fullName(l))}${allReps ? ` · ${esc(l.rep || 'No rep')}` : ''}</div>
        <div class="lead-ago">${trackIcon(l)}<span>${timeAgo(lastTouch(l))}</span></div>
      </div>`).join('')
    : `<div class="empty list-empty">${query.trim() ? 'No leads match your search.' : pipelineFilters.rep || pipelineFilters.status ? 'No leads match these filters.' : 'No leads yet.'}</div>`;
}

// Rep, status, sort, and density stay together in one compact disclosure instead of expanding the toolbar.
const leadOptions = $('leadOptions');
const leadOptionsSummary = leadOptions.querySelector('summary');
const leadRepFilter = $('leadRepFilter');
const leadStatusFilter = $('leadStatusFilter');
const leadSort = $('leadSort');
const leadDensity = $('leadDensity');
const repsInPipeline = [...new Set(leads.map(l => l.rep).filter(Boolean))].sort((a, b) => a.localeCompare(b));
leadRepFilter.innerHTML = '<option value="">All reps</option>' + repsInPipeline.map(rep => `<option value="${esc(rep)}">${esc(rep)}</option>`).join('');
leadRepFilter.addEventListener('change', () => { pipelineFilters.rep = leadRepFilter.value; renderLeads(); });
leadStatusFilter.addEventListener('change', () => { pipelineFilters.status = leadStatusFilter.value; renderLeads(); });
leadSort.addEventListener('change', () => { pipelineFilters.sort = leadSort.value; renderLeads(); });
const syncLeadDensity = () => { leadDensity.value = VIEW.get().lists === 'compact' ? 'compact' : 'normal'; };
leadDensity.addEventListener('change', () => VIEW.set({ lists: leadDensity.value === 'compact' ? 'compact' : 'normal' }));
addEventListener('viewchange', syncLeadDensity);
syncLeadDensity();
leadOptions.addEventListener('toggle', () => leadOptionsSummary.setAttribute('aria-expanded', leadOptions.open));
document.addEventListener('pointerdown', e => { if (leadOptions.open && !leadOptions.contains(e.target)) leadOptions.open = false; });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !leadOptions.open) return;
  e.preventDefault();
  e.stopPropagation();
  leadOptions.open = false;
  leadOptionsSummary.focus();
}, true);

// Opening a lead counts as work for the rep who opens it (the Activity Log shows it as their last lead opened).
function selectLead(id) {
  if (id !== selectedId) workLog.add('leadopen', { leadId: id });
  showLead(id);
}
function showLead(id) {
  if (noteTimer) saveNote();
  selectedId = id;
  document.querySelectorAll('.lead-row').forEach(r => r.classList.toggle('selected', Number(r.dataset.id) === id));
  renderDetail();
  openLeadConversation(currentLead());
  prefillDialer();
  renderDialer();
}
// Opens a lead on the Leads page from another page. When the owner opens another rep's lead, All reps turns on so it shows.
function openLead(id) {
  const l = leads.find(x => x.id === id);
  if (!l || (!canSee(l.rep) && !isOwner)) return;
  if (!canSee(l.rep)) setWorkScope('all');
  showPage('leads');
  selectLead(id);
  $('leadList').querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}
// After My work / All reps changes: the open lead stays if it is still shown, else the top lead opens.
// An open conversation or contact card in Panel 3 goes back to that lead's, so nothing from a hidden lead stays on screen.
function refitLeads() {
  if (!myLeads().some(l => l.id === selectedId)) showLead((myLeads()[0] || {}).id ?? null);
  else if (view.page === 'thread' || view.page === 'contact') openLeadConversation(currentLead());
  else renderComms();
  renderLeads();
}


// ── PANEL 2 · COMPANY INFO ──
// Full months on file, newest first, ending with last month, plus month-to-date when the file has it.
// NSF fees fall in the latest 3 full months.
function statementsOf(l) {
  const b = l.bank;
  if (!b) return [];
  const now = wall();
  const month = { month: 'short' }, monthYear = { month: 'short', year: 'numeric' };
  const months = Array.from({ length: b.months }, (_, i) => {
    const d = new Date(Date.UTC(now.y, now.mo - 1 - i, 1));
    const vary = k => 0.85 + 0.3 * (((l.id * 97 + i * 31 + k * 17) % 100) / 100);
    return {
      label: showTime(d, month, 'UTC').toUpperCase(),
      name: showTime(d, monthYear, 'UTC'),
      deposits: Math.round(b.deposits * vary(1) / 100) * 100,
      balance: Math.round(b.balance * vary(2) / 100) * 100,
      nsf: i < 3 ? Math.floor(b.nsf / 3) + (i < b.nsf % 3 ? 1 : 0) : 0
    };
  });
  if (!b.mtd) return months;
  const asOf = new Date(Date.UTC(now.y, now.mo, Math.min(b.mtd.day, now.d)));
  const asOfText = showTime(asOf, { month: 'short', day: 'numeric' }, 'UTC');
  return [{
    label: 'MTD', name: `Month to date · ${asOfText}`, mtd: true, asOf: asOfText, balance: b.mtd.balance
  }, ...months];
}

const average = list => list.reduce((sum, v) => sum + v, 0) / list.length;

// 2–3 sentences from the statement numbers. It uses averages and trends so it never repeats a figure from the table.
function buildSummary(l) {
  const full = statementsOf(l).filter(s => !s.mtd);
  if (!full.length) return 'No bank statements on file yet, so there is nothing to summarize.';
  const deposits = full.map(s => s.deposits), half = Math.ceil(full.length / 2);
  const trend = full.length > 1 ? Math.round((average(deposits.slice(0, half)) / average(deposits.slice(half)) - 1) * 100) : 0;
  const load = Math.round(l.bank.obligations / average(deposits) * 100);
  const nsf = full.slice(0, 3).reduce((sum, s) => sum + s.nsf, 0);
  return [
    `Deposits average about ${money(Math.round(average(deposits) / 1000) * 1000)} a month${full.length > 1 ? ` and are ${trend > 2 ? `up ${trend}%` : trend < -2 ? `down ${-trend}%` : 'steady'} across ${full.length} months` : ''}.`,
    `Loan payments take about ${load}% of deposits, ${load < 25 ? 'so there is room for new funding' : 'so the monthly load is already heavy'}.`,
    nsf === 0 ? 'There are no NSF fees in the last 3 months.' : `There ${nsf === 1 ? 'is 1 NSF fee' : `are ${nsf} NSF fees`} in the last 3 months, so cash flow gets tight at times.`
  ].join(' ');
}

// copy: the exact text copied when the value is tapped.
const fact = (label, value, { wide = false, mono = false, copy = '' } = {}) =>
  `<div class="fact${wide ? ' wide' : ''}"><div class="fact-label">${label}</div><div class="fact-val${value ? (mono ? ' mono' : '') : ' none'}">${
    !value ? 'Not on file' : copy ? `<button class="copy-val" data-copy="${esc(copy)}" title="Tap to copy">${esc(value)}</button>` : esc(value)}</div></div>`;
// One small label per group; only what is on file is listed, or "None".
const contactGroup = (label, items, { wide = false, list = 'contact-list' } = {}) =>
  `<div class="contact-group${wide ? ' wide' : ''}"><div class="fact-label">${label}</div><div class="${list}">${items.length ? items.join('') : '<span class="none">None</span>'}</div></div>`;
const numberBtn = num => `<button class="link-btn contact-value" data-pop="number" data-value="${num}" title="Call ${fmtPhone(num)}">${fmtPhone(num)}</button>`;


// ── HEADER ACTIONS: CALL · SMS · WHATSAPP · EMAIL ──
// One tap uses the last number or email used for that lead, else the first on file. ▾ picks another.
const lastUsed = store.read('nv.lastUsed', {});
const ACTS = {
  call:  { icon: 'phone', verb: 'Call', none: 'No phone number on file', key: 'C' },
  sms:   { icon: 'sms', verb: 'Text', none: 'No mobile number on file', key: 'T' },
  wa:    { icon: 'wa', verb: 'WhatsApp', none: 'No mobile number on file', key: 'W' },
  email: { icon: 'mail', verb: 'Email', none: 'No email on file', key: 'E' }
};
const typeName = { mobile: 'Mobile', landline: 'Landline' };
function actOptions(kind, l) {
  if (kind === 'email') return [...l.emails.map(e => ({ value: e, label: e })), ...(l.emails.length > 1 ? [{ value: '*all', label: `Email all (${l.emails.length})` }] : [])];
  const phones = kind === 'call' ? l.phones : l.phones.filter(p => p.type === 'mobile');
  return phones.map(p => ({ value: p.num, label: `${typeName[p.type]} · ${fmtPhone(p.num)}` }));
}
function actTarget(kind, l) {
  const options = actOptions(kind, l), used = (lastUsed[l.id] || {})[kind];
  return (options.find(o => o.value === used) || options[0] || {}).value || '';
}
function actLabel(kind, value) {
  const a = ACTS[kind];
  if (!value) return a.none;
  return `${a.verb} ${value === '*all' ? 'all emails' : kind === 'email' ? value : fmtPhone(value)} (${a.key})`;
}
function renderActs() {
  const l = currentLead();
  $('acts').innerHTML = Object.keys(ACTS).map(kind => {
    const label = actLabel(kind, actTarget(kind, l));
    return actOptions(kind, l).length > 1
      ? `<button class="act-btn ${kind}" data-pick="${kind}" title="Choose who to ${ACTS[kind].verb.toLowerCase()} (${ACTS[kind].key})" aria-label="Choose who to ${ACTS[kind].verb.toLowerCase()}" aria-haspopup="menu">${ic(ACTS[kind].icon, 14)}</button>`
      : `<button class="act-btn ${kind}" data-act="${kind}" title="${esc(label)}" aria-label="${esc(label)}">${ic(ACTS[kind].icon, 14)}</button>`;
  }).join('');
}
// A tap on a button with more than one number or email opens the list (data-pick). Otherwise the tap, and the
// C T W E keys, act right away on the last-used choice. With nothing on file, the list opens to say so.
function quickAct(kind, l = currentLead()) {
  const value = actTarget(kind, l);
  if (value || kind === 'call') runAct(kind, value, l);
  else openPicker(kind, $('acts').querySelector(`.act-btn.${kind}`), l);
}
function runAct(kind, value, l = currentLead()) {
  if (value && value !== '*all') { (lastUsed[l.id] ||= {})[kind] = value; store.write('nv.lastUsed', lastUsed); }
  if (kind === 'call') callNumber(value);
  else if (kind === 'sms') openText(value);
  else if (kind === 'wa') openWhatsApp(value);
  else composeEmail(value === '*all' ? { to: [l.emails[0]], bcc: l.emails.slice(1) } : { to: [value] });
  if (l.id === selectedId) renderActs();
}

function renderDetail() {
  const l = currentLead();
  if (!l) { $('detail').innerHTML = '<p class="empty detail-empty">No lead is open.</p>'; return; }
  const b = l.bank;
  const notes = notesStore[l.id] ?? l.notes;
  const mobiles = l.phones.filter(p => p.type === 'mobile'), landlines = l.phones.filter(p => p.type === 'landline');
  const years = l.started ? yearsSince(l.started) : 0;
  const contactFields = (label, values) => (values.length ? values : ['<span class="none">None</span>'])
    .map(value => `<div class="fact contact-fact"><div class="fact-label">${label}</div><div class="fact-val">${value}</div></div>`);
  const contactRows = [
    ...contactFields('Mobile', mobiles.slice(0, 2).map(p => numberBtn(p.num))),
    ...contactFields('Landline', landlines.slice(0, 2).map(p => numberBtn(p.num))),
    ...contactFields('Email', l.emails.map(e => `<button class="link-btn contact-value" data-pop="email" data-value="${esc(e)}" title="Email ${esc(e)}">${esc(e)}</button>`))
  ].join('');
  $('detail').innerHTML = `
    <div class="detail-head">
      <div class="detail-title">
        <div class="detail-name">${esc(l.legal || l.company)}</div>
        <div class="detail-sub">
          <span>${esc(fullName(l))}</span>
          ${l.address ? `<button class="detail-addr" data-pop="address" data-value="${esc(l.address)}" title="Map or copy">${ic('pin', 12)}<span>${esc(l.address)}</span></button>` : ''}
          ${zoneOf(l.address) ? `<span class="detail-time" title="Their local time">${ic('clock', 11)}<span data-zone="${zoneOf(l.address)}"></span> local</span>` : ''}
        </div>
      </div>
      <div class="acts" id="acts"></div>
    </div>
    <div class="detail-body">
      <div class="info-pair">
      <div class="section section-card company-info-section">
        <div class="section-title"><svg class="section-title-icon ic" aria-hidden="true" width="0.875rem" height="0.875rem"><use href="#i-layers"/></svg><span>Company</span></div>
        <div class="facts">
          ${l.dba ? fact('DBA', l.dba, { copy: l.dba }) : ''}
          ${fact('EIN', l.ein, { mono: true, copy: l.ein })}
          ${fact('Birth date', l.dob && `${fmtDate(l.dob)} · age ${yearsSince(l.dob)}`)}
          ${fact('SSN', l.ssn, { mono: true, copy: l.ssn })}
          ${fact('Start date', l.started && `${fmtDate(l.started)} · ${years < 1 ? 'under 1 yr' : years + (years === 1 ? ' yr' : ' yrs')}`)}
          ${fact('Industry', l.industry)}
          ${fact('Applied', l.applied && fmtDate(l.applied))}
          ${l.address2 ? fact('Address 2', l.address2, { wide: true, copy: l.address2 }) : ''}
          ${l.address3 ? fact('Address 3', l.address3, { wide: true, copy: l.address3 }) : ''}
        </div>
      </div>
      <div class="section section-card contact-info-section">
        <div class="section-title"><svg class="section-title-icon ic" aria-hidden="true" width="0.875rem" height="0.875rem"><use href="#i-contacts"/></svg><span>Contacts</span></div>
        <div class="contact-facts">${contactRows}</div>
      </div>
      </div>
      <div class="section section-pair">
        <div class="section-card">
          <div class="section-title"><svg class="section-title-icon ic" aria-hidden="true" width="0.875rem" height="0.875rem"><use href="#i-file"/></svg><span>Banking</span></div>
          ${b ? `<div class="facts">${fact('Bank', b.name)}${fact('Account #', b.account, { mono: true, copy: b.account })}</div><table class="stmt" id="stmts"></table>`
            : '<div class="empty">No bank statements on file.</div>'}
        </div>
        <div class="section-card">
          <div class="section-title"><svg class="section-title-icon ic" aria-hidden="true" width="0.875rem" height="0.875rem"><use href="#i-clock"/></svg><span>Activity</span></div>
          <div id="feed"></div>
        </div>
      </div>
      ${b ? `<div class="section section-card financial-pitch-card">
        <div class="section-title"><span>Financial outlook</span></div>
        <p class="summary">${esc(buildSummary(l))}</p>
      </div>` : ''}
      <div class="section section-card notes-section" id="notesSection">
        <button class="section-title notes-toggle" type="button" id="notesToggle"><svg class="section-title-icon ic" aria-hidden="true" width="0.875rem" height="0.875rem"><use href="#i-note"/></svg><span>Notes</span><span class="save-state" id="noteState"></span></button>
        <textarea class="notes-textarea" id="notesText" data-lead="${l.id}" rows="4" placeholder="Add a note… it saves by itself">${esc(notes)}</textarea>
      </div>
    </div>`;
  renderActs();
  updateZoneClocks();
  renderStatements();
  renderFeed();
}

// A lead's own local time (Company Info, the WhatsApp chat header), kept current each minute.
function updateZoneClocks() {
  document.querySelectorAll('[data-zone]').forEach(el => { el.textContent = clockTime(Date.now(), el.dataset.zone); });
}

function renderStatements() {
  const table = $('stmts');
  if (!table) return;
  table.innerHTML = `
    <thead><tr><th scope="col">Month</th><th scope="col">Deposits</th><th scope="col">Balance</th></tr></thead>
    <tbody>${statementsOf(currentLead()).map(s => `
      <tr>
        <td><span class="stmt-month">${s.label}</span></td>
        ${s.mtd ? `<td class="as-of">as of ${s.asOf}</td>` : `<td>${money(s.deposits)}</td>`}
        <td>${money(s.balance)}</td>
      </tr>`).join('')}
    </tbody>`;
}

function renderFeed() {
  const l = currentLead(), live = activityStore[l.id] || [];
  const item = (kind, text, sub, fresh = '') => `<div class="feed-item${fresh}">${kindIcon(kind)}<div><div class="feed-text">${esc(text)}</div><div class="feed-sub">${esc(sub)}</div></div></div>`;
  const e = mail.tracking(l), opened = e && e.opens.length ? [{ type: 'open', text: `Email opened (${e.opens.length}×) · “${e.subject}”`, at: e.opens[0] }] : [];
  const recent = [
    ...[...live, ...opened].sort((a, b) => b.at - a.at).map(a => item(a.type, a.text, dayTime(a.at), newRow(`${l.id}|${a.type}|${a.at}`, a.at))),
    ...l.history.map(h => item(h.type, h.subject, `${h.preview} · ${h.date}`))
  ].join('');
  $('feed').innerHTML = `
    <div class="feed-group">Coming up<button class="link-btn" type="button" data-remind-add>Remind me</button></div>${reminders.feedHtml(l.id) || '<div class="empty">Nothing scheduled.</div>'}
    <div class="feed-group">Recent</div>${recent || '<div class="empty">No activity yet.</div>'}`;
}

$('detail').addEventListener('click', e => {
  const l = currentLead();
  if (!l) return;
  if (e.target.closest('#notesToggle')) {
    $('notesSection').classList.toggle('open');
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) { quickAct(act.dataset.act, l); return; }
  const copy = e.target.closest('[data-copy]');
  if (copy) copyAndShow(copy.dataset.copy, copy);
});

// Notes save by themselves shortly after you stop typing, and right away when you switch leads or leave.
let noteTimer = 0;
function saveNote() {
  clearTimeout(noteTimer);
  noteTimer = 0;
  const el = $('notesText');
  if (!el) return;
  notesStore[el.dataset.lead] = el.value;
  $('noteState').textContent = store.write('nv.notes', notesStore) ? 'Saved' : '';
  workLog.add('note', { leadId: Number(el.dataset.lead) });
}
$('detail').addEventListener('input', e => {
  if (e.target.id !== 'notesText') return;
  $('noteState').textContent = 'Saving…';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(saveNote, 600);
});
addEventListener('pagehide', () => { if (noteTimer) saveNote(); });


// ── SMALL ACTION POP-UP ──
// One pop-up for every small menu: tapping a number, an email or the address, and the ▾ pickers in the header.
const pop = $('pop');
let popAnchor = null;
let popItems = [];

function openPop(anchor, items, { list = false } = {}) {
  popAnchor = anchor;
  popItems = items;
  pop.className = 'pop open' + (list ? ' list' : '');
  pop.innerHTML = items.map((it, i) => it.run
    ? `<button class="pop-item ${it.cls || ''}" data-i="${i}" role="menuitem" title="${esc(it.label)}" aria-label="${esc(it.label)}">${it.icon ? ic(it.icon, 13) : ''}${it.compact ? '' : esc(it.label)}</button>`
    : `<div class="pop-note">${esc(it.label)}</div>`).join('');
  pop.inert = false;
  const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = clamp(r.left, 8, innerWidth - w - 8) + 'px';
  pop.style.top = clamp(r.bottom + 6 + h > innerHeight - 8 ? r.top - 6 - h : r.bottom + 6, 8, innerHeight - h - 8) + 'px';
}

function closePop() {
  if (!popAnchor) return;
  popAnchor = null;
  pop.classList.remove('open');
  pop.inert = true;
}

function valuePopItems(type, value, anchor) {
  const copy = { icon: 'copy', label: 'Copy', compact: true, run: () => copyAndShow(value, anchor) };
  if (type === 'number') return [
    { icon: 'phone', label: 'Call', cls: 'call', compact: true, run: () => callNumber(value) },
    { icon: 'sms', label: 'Text', cls: 'sms', compact: true, run: () => openText(value) },
    { icon: 'wa', label: 'WhatsApp', cls: 'wa', compact: true, run: () => openWhatsApp(value) }, copy];
  if (type === 'email') return [{ icon: 'mail', label: 'Email', cls: 'email', compact: true, run: () => composeEmail({ to: [value] }) }, copy];
  return [{ icon: 'map', label: 'Map', cls: 'call', compact: true, run: () => openLink(mapLink(value), true) }, copy];
}

function openPicker(kind, anchor, l = currentLead()) {
  const options = actOptions(kind, l), current = actTarget(kind, l);
  openPop(anchor, options.length
    ? options.map(o => ({ label: o.label, cls: o.value === current ? 'selected' : '', run: () => runAct(kind, o.value, l) }))
    : [{ label: ACTS[kind].none }], { list: true });
}

document.addEventListener('click', e => {
  const trigger = e.target.closest('[data-pop], [data-pick]');
  if (!trigger) return;
  if (popAnchor === trigger) { closePop(); return; }
  if (trigger.dataset.pick) openPicker(trigger.dataset.pick, trigger);
  else openPop(trigger, valuePopItems(trigger.dataset.pop, trigger.dataset.value, trigger));
});
pop.addEventListener('click', e => {
  const btn = e.target.closest('[data-i]');
  if (!btn) return;
  const item = popItems[btn.dataset.i];
  closePop();
  item.run();
});
addEventListener('scroll', closePop, true);


// ── EMAIL TRACKING CARD ──
// Hover (or tap) the envelope in a lead row to see when the latest email was sent and every time it was opened.
const trackCard = $('trackCard');
let trackFor = null;
function showTrack(btn) {
  const e = mail.tracking(leads.find(l => l.id === Number(btn.dataset.track)));
  trackFor = btn;
  trackCard.innerHTML = `
    <div class="tc-subject">${esc(e.subject)}</div>
    <div class="tc-line">Sent ${dayTime(e.sent)}</div>
    ${e.opens.length
      ? `<ol class="tc-opens">${e.opens.map((at, i) => `<li>${dayTime(at)}<span>${i === 0 ? 'latest' : ''}</span></li>`).join('')}</ol>`
      : '<div class="tc-line">Not opened yet</div>'}`;
  trackCard.classList.add('open');
  const r = btn.getBoundingClientRect(), h = trackCard.offsetHeight;
  trackCard.style.left = clamp(r.right + 8, 8, innerWidth - trackCard.offsetWidth - 8) + 'px';
  trackCard.style.top = clamp(r.top - 10, 8, innerHeight - h - 8) + 'px';
}
function hideTrack() { trackFor = null; trackCard.classList.remove('open'); }
$('leadList').addEventListener('pointerover', e => { const b = e.target.closest('[data-track]'); if (b && e.pointerType === 'mouse' && b !== trackFor) showTrack(b); });
$('leadList').addEventListener('pointerout', e => { if (trackFor && e.pointerType === 'mouse' && !trackFor.contains(e.relatedTarget)) hideTrack(); });
$('leadList').addEventListener('focusin', e => { const b = e.target.closest('[data-track]'); if (b) showTrack(b); });
$('leadList').addEventListener('focusout', hideTrack);
$('leadList').addEventListener('click', e => { const b = e.target.closest('[data-track]'); if (b && e.pointerType !== 'mouse') (trackFor === b ? hideTrack() : showTrack(b)); });
$('leadList').addEventListener('scroll', hideTrack);


// ── PANEL RESIZE ──
// Drag the line between two panels (or focus it and press ← →), or use Settings, to set the width of the Leads or
// Communications panel. Company Info in the middle takes whatever room is left and never gets narrower than its minimum.
// Widths are kept as design sizes (at 16px to 1rem), so a width grows and shrinks with the screen like everything else.
// They are worked out from the styles, not from what is drawn, so Settings can set them while another page is showing.
const panelSizes = (() => {
  const resizable = { leads: document.querySelector('.panel-leads'), comms: document.querySelector('.panel-comms') };
  const detailPanel = document.querySelector('.panel-detail'), workspace = $('leadsPage');
  const saved = store.read('nv.panelWidths', {});
  const design = px => px / remPx() * 16;
  const styleSize = (el, prop) => design(parseFloat(getComputedStyle(el)[prop]));
  const handleOf = name => document.querySelector(`[data-resize="${name}"]`);

  // The widest a panel can be: the room beside the sidebar, less the other panel, Company Info at its minimum, and both 8px resize gutters.
  function limits(name) {
    const room = design(document.querySelector('.body-area').clientWidth - document.querySelector('.sidebar').offsetWidth);
    const other = resizable[name === 'leads' ? 'comms' : 'leads'];
    const gutters = [...workspace.querySelectorAll('.resizer')].reduce((sum, handle) => sum + design(handle.offsetWidth), 0);
    const min = 192;
    const max = Math.floor(room - gutters - styleSize(detailPanel, 'minWidth') - styleSize(other, 'flexBasis'));
    return { min, max: Math.max(min, max) };
  }
  const width = name => Math.round(styleSize(resizable[name], 'flexBasis'));
  function sync(name) {
    const { min, max } = limits(name), handle = handleOf(name);
    handle.setAttribute('aria-valuenow', width(name));
    handle.setAttribute('aria-valuemin', min);
    handle.setAttribute('aria-valuemax', max);
  }
  function set(name, value) {
    const { min, max } = limits(name);
    saved[name] = Math.round(clamp(value, min, max));
    resizable[name].style.flex = `0 0 ${rem(saved[name])}`;
    sync(name);
  }
  const save = () => store.write('nv.panelWidths', saved);
  function reset() {
    Object.keys(resizable).forEach(name => { delete saved[name]; resizable[name].style.flex = ''; });
    Object.keys(resizable).forEach(sync);
    save();
  }

  Object.keys(resizable).forEach(name => {
    if (saved[name]) resizable[name].style.flex = `0 0 ${rem(saved[name])}`;
    const handle = handleOf(name), dir = name === 'leads' ? 1 : -1;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, startW = resizable[name].offsetWidth;
      handle.classList.add('dragging');
      const move = ev => set(name, design(startW + dir * (ev.clientX - startX)));
      const up = () => {
        handle.classList.remove('dragging');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        save();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    });
    handle.addEventListener('keydown', e => {
      const step = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
      if (!step) return;
      e.preventDefault();
      set(name, width(name) + dir * step);
      save();
    });
  });
  Object.keys(resizable).forEach(sync);
  return { limits, width, set, save, reset };
})();


// ── PANEL 3 · COMMUNICATIONS ──
// Sample texts and calls come from sample-data.js until real data is connected.
// Numbers on an iPhone get blue iMessage bubbles; every other text is a green SMS bubble.
const IMESSAGE_NUMBERS = new Set(sample('imessageNumbers', []));
const serviceOf = number => IMESSAGE_NUMBERS.has(number) ? 'imessage' : 'sms';
// A text is [channel, number, direction, text, minutes ago, phone, unread, receipt]; a call is [number, direction, minutes ago, seconds talked, phone].
// An outgoing message has a receipt: status 'sent', 'delivered' or 'read' (with readAt), set by the phone or WhatsApp
// service. In the sample data the receipt is 'sent', 'delivered' (the default) or the minutes ago it was read.
const messageRows = sample('messages', []);
const callRows = sample('calls', []);
const leadIdOf = number => (leadByNumber(number) || {}).id || null;
const messages = messageRows.map(([channel, number, dir, text, mins, phone, unread = false, receipt = 'delivered'], i) => ({
  id: 'm' + i, channel, number, leadId: leadIdOf(number), dir, text, at: ago(mins), phone: 'Phone ' + phone,
  service: channel === 'text' ? serviceOf(number) : 'wa', files: [], read: !unread,
  status: dir !== 'out' ? '' : typeof receipt === 'number' ? 'read' : receipt, readAt: typeof receipt === 'number' ? ago(receipt) : 0
}));
const calls = callRows.map(([number, dir, mins, seconds, phone], i) => ({
  id: 'c' + i, number, leadId: leadIdOf(number), dir, at: ago(mins), seconds, phone: 'Phone ' + phone, seen: dir !== 'missed'
}));
// A text or call belongs to its lead's rep. With no lead, it belongs to the rep whose phone it was on (rep), if known.
const lineRep = x => { const l = leads.find(y => y.id === x.leadId); return l ? l.rep : x.rep || ''; };
const shownMessages = () => messages.filter(m => canSee(lineRep(m)));
const shownCalls = () => calls.filter(c => canSee(lineRep(c)));

const fmtDuration = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const fmtSize = bytes => bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';
const nameOf = (leadId, number) => { const l = leads.find(x => x.id === leadId); return l ? fullName(l) : fmtPhone(number); };
const avatarOf = (leadId, size = '') => {
  const l = leads.find(x => x.id === leadId);
  return avatar(l ? fullName(l) : '', { photo: l && l.photo, size });
};
function listTime(ts) {
  const days = daysAgo(ts);
  return days === 0 ? clockTime(ts) : days === 1 ? 'Yesterday' : days < 7
    ? showTime(ts, { weekday: 'long' })
    : showTime(ts, { month: 'numeric', day: 'numeric', year: '2-digit' });
}
function dayName(ts) {
  const days = daysAgo(ts);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : showTime(ts, { weekday: 'short', month: 'short', day: 'numeric' });
}

function threadsOf(channel) {
  const map = new Map();
  shownMessages().filter(m => !channel || m.channel === channel).forEach(m => {
    const key = m.channel + ':' + m.number, t = map.get(key) || { channel: m.channel, number: m.number, leadId: m.leadId, last: m, unread: 0 };
    if (m.at >= t.last.at) t.last = m;
    if (m.dir === 'in' && !m.read) t.unread++;
    map.set(key, t);
  });
  return [...map.values()].sort((a, b) => b.last.at - a.last.at);
}
const threadMessages = (channel, number) => messages.filter(m => m.channel === channel && m.number === number).sort((a, b) => a.at - b.at);

// Where Panel 3 is: a tab's list, a conversation, the contacts list or one contact card. Back returns to the page before.
const view = { tab: 'all', msgs: 'text', calls: 'all', page: 'list', thread: null, contactId: null, query: '' };
let backStack = [];
const snapshot = () => ({ tab: view.tab, msgs: view.msgs, calls: view.calls, page: view.page, thread: view.thread, contactId: view.contactId });
function go(changes) { backStack.push(snapshot()); Object.assign(view, changes); renderComms(); }
function goBack() { Object.assign(view, backStack.pop() || { page: 'list' }); renderComms(); }
function setTab(tab) { backStack = []; Object.assign(view, { tab, page: 'list', thread: null, contactId: null }); if (tab === 'calls') calls.forEach(c => { c.seen = true; }); renderComms(); }

// The list Panel 3 is on, or the one the open conversation came from. Back returns to it.
const listState = () => view.page === 'list' ? snapshot() : backStack[0] || { tab: 'all', msgs: view.msgs, calls: view.calls, page: 'list', thread: null, contactId: null };
function openThread(channel, number) {
  if (channel === 'text' || channel === 'wa') clearDialerDraft();
  backStack = [listState()];
  Object.assign(view, { tab: 'msgs', msgs: channel, page: 'thread', thread: { channel, number }, contactId: null });
  messages.forEach(m => { if (m.channel === channel && m.number === number) m.read = true; });
  renderComms();
}
// Picking a lead opens their latest conversation when they have one. Otherwise Panel 3 shows its list.
function openLeadConversation(l) {
  const latest = l && messages.filter(m => m.leadId === l.id).sort((a, b) => b.at - a.at)[0];
  if (latest) { openThread(latest.channel, latest.number); return; }
  Object.assign(view, listState());
  backStack = [];
  renderComms();
}
function openText(number) {
  const lead = leadByNumber(number);
  if (lead && lead.id !== selectedId) selectLead(lead.id);
  openThread('text', digitsOf(number).slice(-10));
  $('composerInput').focus();
}
function openWhatsApp(number) {
  const lead = leadByNumber(number);
  if (lead && lead.id !== selectedId) selectLead(lead.id);
  openThread('wa', digitsOf(number).slice(-10));
  $('composerInput').focus();
}

// Sends a text or WhatsApp message through the phone engine. Returns what the engine returned (null when not sent).
// It goes out on the lead's rep's own phone line, so a reply the owner sends on a rep's lead looks like the rep's own.
// by: who really sent it. It counts only in the Activity Log of the person who sent it.
function sendMessage(channel, number, text, files = []) {
  const leadId = leadIdOf(number), rep = leadId ? lineRep({ leadId }) : user.name;
  const sent = phoneEngine.sendMessage(toDial(number), text, rep);
  if (!sent) return null;
  workLog.add(channel === 'wa' ? 'wa' : 'text', { leadId, number, text: text || `${files.length} ${files.length === 1 ? 'file' : 'files'}` });
  messages.push({
    id: 'm' + sent.at + messages.length, channel, number, leadId, rep, by: user.name, dir: 'out', text, at: sent.at, phone: sent.phone,
    service: channel === 'text' ? serviceOf(number) : 'wa', read: true, status: 'sent', readAt: 0,
    files: files.map(f => ({ name: f.name, size: f.size, type: f.type, url: URL.createObjectURL(f) }))
  });
  const what = text ? `“${text}”` : `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
  if (leadId) logActivity(leadId, channel, `${channel === 'wa' ? 'WhatsApp' : 'Text'} to ${fmtPhone(number)}: ${what}`);
  renderComms();
  return sent;
}

// WhatsApp checks on a message you sent: one grey (sent), two grey (delivered), two blue (read). Hover shows the read time.
function waTicks(m) {
  if (m.dir !== 'out') return '';
  const title = m.status === 'read' ? 'Read ' + dayTime(m.readAt) : m.status === 'sent' ? 'Sent' : 'Delivered';
  return `<span class="ticks${m.status === 'read' ? ' read' : ''}" title="${title}">${ic(m.status === 'sent' ? 'check' : 'checks', 14)}</span>`;
}

const filesHtml = files => files.map(f => f.type.startsWith('image/')
  ? `<a href="${f.url}" target="_blank" rel="noopener"><img class="msg-img" src="${f.url}" alt="${esc(f.name)}"></a>`
  : `<a class="msg-file" href="${f.url}" download="${esc(f.name)}">${ic('file', 16)}<span>${esc(f.name)}</span><small>${fmtSize(f.size)}</small></a>`).join('');

function chatHtml(channel, number) {
  const list = threadMessages(channel, number);
  if (!list.length) return `<div class="chat${channel === 'wa' ? ' wa' : ''}"><div class="ios-empty">No messages yet.</div></div>`;
  // iMessage shows Delivered or Read under the last message sent; SMS shows neither, like an iPhone.
  const lastOut = [...list].reverse().find(m => m.dir === 'out');
  const receipt = m => m !== lastOut || m.service !== 'imessage' ? '' : m.status === 'read' ? ` · <b>Read</b> ${listTime(m.readAt)}` : m.status === 'delivered' ? ' · <b>Delivered</b>' : '';
  let prev = 0;
  const rows = list.map(m => {
    // iMessage shows the day and time after a gap of an hour or more; WhatsApp shows only the day, once per day.
    const newDay = dayStart(m.at) !== dayStart(prev);
    const day = channel === 'wa'
      ? (newDay ? `<div class="chat-day">${dayName(m.at)}</div>` : '')
      : (newDay || m.at - prev > 3600000 ? `<div class="chat-day"><b>${dayName(m.at)}</b> ${clockTime(m.at)}</div>` : '');
    prev = m.at;
    if (channel === 'wa') {
      return `${day}<div class="msg ${m.dir}${newRow(m.id, m.at)}"><div class="bubble">${filesHtml(m.files)}${esc(m.text)}<span class="wa-time">${clockTime(m.at)}${waTicks(m)}</span></div></div>`;
    }
    return `${day}<div class="msg ${m.dir} ${m.service}${newRow(m.id, m.at)}">${filesHtml(m.files)}${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}<div class="msg-time">${clockTime(m.at)}${receipt(m)}</div></div>`;
  }).join('');
  return `<div class="chat${channel === 'wa' ? ' wa' : ''}">${rows}</div>`;
}

const callText = c => c.dir === 'missed' ? 'Missed call' : `${c.dir === 'out' ? 'Outgoing' : 'Incoming'} call · ${c.seconds ? fmtDuration(c.seconds) : 'no answer'}`;
const phoneType = number => { const p = leads.flatMap(l => l.phones).find(x => x.num === number); return p ? typeName[p.type].toLowerCase() : 'unknown'; };

function threadRow(t, look) {
  const last = t.last, preview = last.text || `${last.files.length} ${last.files.length === 1 ? 'attachment' : 'attachments'}`;
  if (look === 'wa') {
    return `<button class="wa-row${t.unread ? ' unread' : ''}" data-thread="wa" data-number="${t.number}">${avatarOf(t.leadId, 'sm')}<div class="wa-main">
      <div class="wa-line"><span class="wa-name">${esc(nameOf(t.leadId, t.number))}</span><span class="wa-when${t.unread ? ' new' : ''}">${listTime(last.at)}</span></div>
      <div class="wa-line"><span class="wa-preview">${waTicks(last)}${esc(preview)}</span></div></div></button>`;
  }
  return `<button class="ios-row${t.unread ? ' unread' : ''}" data-thread="text" data-number="${t.number}">${avatarOf(t.leadId, 'sm')}<div class="ios-main">
    <div class="ios-top"><span class="ios-name">${esc(nameOf(t.leadId, t.number))}</span><span class="ios-time">${listTime(last.at)}${ic('chevron-right', 12)}</span></div>
    <div class="ios-preview">${esc(preview)}</div></div></button>`;
}

function callRow(c) {
  return `<div class="ios-row" data-open-call="${c.number}" role="button" tabindex="0" title="Open ${fmtPhone(c.number)}">
    <span class="call-dir">${c.dir === 'out' ? ic('outgoing', 13) : ''}</span><div class="ios-main">
    <div class="ios-top"><span class="ios-name${c.dir === 'missed' ? ' missed' : ''}">${esc(nameOf(c.leadId, c.number))}</span><span class="ios-time">${listTime(c.at)}</span>
    <button class="row-icon" data-call="${c.number}" title="Call ${fmtPhone(c.number)}" aria-label="Call ${fmtPhone(c.number)}">${ic('phone', 15)}</button>
    <button class="row-icon" data-text="${c.number}" title="Text ${fmtPhone(c.number)}" aria-label="Text ${fmtPhone(c.number)}">${ic('sms', 15)}</button></div>
    <div class="ios-meta">${phoneType(c.number)} · ${fmtPhone(c.number)} · ${callText(c)}</div></div></div>`;
}

function allRow(item) {
  if (item.mail) {
    const m = item.mail;
    return `<div class="ios-row${m.unread ? ' unread' : ''}" data-open-mail="${m.id}" role="button" tabindex="0">${avatarOf(m.leadId, 'sm')}<div class="ios-main">
      <div class="ios-top"><span class="ios-name">${esc(m.name)}</span><span class="ios-time">${listTime(m.at)}</span></div>
      <div class="ios-preview">${m.out ? 'You: ' : ''}${esc(m.subject)}</div>
      <div class="ios-meta"><span class="src email">${ic('mail', 9)}</span>Email · ${esc(m.out ? m.account : m.peer)}</div></div></div>`;
  }
  if (item.call) {
    const c = item.call;
    return `<div class="ios-row" data-open-call="${c.number}" role="button" tabindex="0">${avatarOf(c.leadId, 'sm')}<div class="ios-main">
      <div class="ios-top"><span class="ios-name${c.dir === 'missed' ? ' missed' : ''}">${esc(nameOf(c.leadId, c.number))}</span><span class="ios-time">${listTime(c.at)}</span>
      <button class="row-icon" data-call="${c.number}" title="Call ${fmtPhone(c.number)}" aria-label="Call ${fmtPhone(c.number)}">${ic('phone', 15)}</button>
      <button class="row-icon" data-text="${c.number}" title="Text ${fmtPhone(c.number)}" aria-label="Text ${fmtPhone(c.number)}">${ic('sms', 15)}</button></div>
      <div class="ios-preview">${callText(c)}</div>
      <div class="ios-meta"><span class="src ${c.dir === 'missed' ? 'missed' : 'call'}">${ic('phone', 9)}</span>${c.phone} · ${fmtPhone(c.number)}</div></div></div>`;
  }
  const t = item.thread, last = t.last;
  return `<button class="ios-row${t.unread ? ' unread' : ''}" data-thread="${t.channel}" data-number="${t.number}">${avatarOf(t.leadId, 'sm')}<div class="ios-main">
    <div class="ios-top"><span class="ios-name">${esc(nameOf(t.leadId, t.number))}</span><span class="ios-time">${listTime(last.at)}</span></div>
    <div class="ios-preview">${last.dir === 'out' ? 'You: ' : ''}${esc(last.text || 'Attachment')}</div>
    <div class="ios-meta"><span class="src ${t.channel}">${ic(t.channel === 'wa' ? 'wa' : 'sms', 9)}</span>${t.channel === 'wa' ? 'WhatsApp' : last.service === 'imessage' ? 'iMessage' : 'SMS'} · ${last.phone} · ${fmtPhone(t.number)}</div></div></button>`;
}

function contactsHtml() {
  const q = view.query.trim().toLowerCase(), qd = digitsOf(q);
  const list = myLeads().filter(l => !q || fullName(l).toLowerCase().includes(q) || l.company.toLowerCase().includes(q)
    || l.emails.some(e => e.toLowerCase().includes(q)) || (qd.length > 2 && l.phones.some(p => p.num.includes(qd))))
    .sort((a, b) => (a.last + a.first).localeCompare(b.last + b.first));
  if (!list.length) return '<div class="ios-empty">No results</div>';
  let letter = '';
  return list.map(l => {
    const head = l.last[0].toUpperCase() !== letter ? `<div class="ios-letter">${(letter = l.last[0].toUpperCase())}</div>` : '';
    return `${head}<button class="ios-row" data-contact="${l.id}"><div class="ios-main"><span class="contact-name">${esc(l.first)} <b>${esc(l.last)}</b></span><span class="company">${esc(l.company)}</span></div></button>`;
  }).join('');
}

function contactCardHtml(l) {
  const tile = (kind, label) => `<button class="card-act" data-card-act="${kind}">${ic(ACTS[kind].icon, 18)}${label}</button>`;
  const cell = (label, value, attr) => `<button class="ios-cell" ${attr}><div class="cell-label">${label}</div><div class="cell-val">${esc(value)}</div></button>`;
  const phones = l.phones.map(p => cell(typeName[p.type].toLowerCase(), fmtPhone(p.num), `data-load="${p.num}" title="Load into the dialer"`)).join('');
  const emails = l.emails.map(e => cell('email', e, `data-mail="${esc(e)}"`)).join('');
  return `<div class="card-page">
    <div class="card-top">${avatarOf(l.id, 'xl')}
      <div class="photo-acts"><button class="link-btn" data-photo="add">${l.photo ? 'Change photo' : 'Add photo'}</button>${l.photo ? '<button class="link-btn" data-photo="remove">Remove photo</button>' : ''}</div>
      <div class="card-name">${esc(fullName(l))}</div><div class="card-company">${esc(l.company)}</div></div>
    <div class="card-acts">${tile('sms', 'message')}${tile('call', 'call')}${tile('wa', 'WhatsApp')}${tile('email', 'mail')}</div>
    ${phones ? `<div class="ios-group">${phones}</div>` : ''}${emails ? `<div class="ios-group">${emails}</div>` : ''}</div>`;
}

// The WhatsApp chat header: photo and name, then when the last message was, then the lead's own local time.
// WhatsApp does not share "last seen" with business tools, so it is not shown.
function waHead(leadId, number) {
  const list = threadMessages('wa', number), lead = leads.find(l => l.id === leadId), zone = lead ? zoneOf(lead.address) : '';
  const last = list.length ? `Last message ${listTime(list[list.length - 1].at)}` : 'No messages yet';
  return `${avatarOf(leadId)}<span class="wa-who"><b>${esc(nameOf(leadId, number))}</b>
    <small>${last}</small>${zone ? `<small><span data-zone="${zone}"></span> local</small>` : ''}</span>`;
}

const TAB_TITLES = { all: 'All', msgs: 'Messages', calls: 'Calls', email: 'Email' };
function updatePhoneBtn() { const pill = $('phoneBtn'); if (pill) pill.outerHTML = phoneBtn(); }
function phoneBtn() {
  const p = phoneEngine.activePhone();
  return `<button class="phone-btn${p.connected ? ' connected' : ''}" id="phoneBtn" title="Phone used to call and send" aria-haspopup="menu"><i class="dot"></i>${esc(p.name)}${ic('chevron', 9)}</button>`;
}

function renderComms() {
  const { tab, page } = view, focusId = $('comms').contains(document.activeElement) ? document.activeElement.id : '';
  const unreadMsgs = shownMessages().filter(m => m.dir === 'in' && !m.read).length, newMissed = shownCalls().filter(c => !c.seen).length;
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = b.dataset.tab === tab && page !== 'contacts' && page !== 'contact';
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  $('badgeMsgs').textContent = unreadMsgs || '';
  $('badgeCalls').textContent = newMissed || '';
  $('badgeEmail').textContent = mail.unreadCount() || '';
  $('contactsBtn').classList.toggle('on', page === 'contacts' || page === 'contact');
  // The Email tab shows the mail screen itself.
  const onMail = tab === 'email' && page === 'list';
  $('comms').hidden = onMail;
  $('mailHostComms').hidden = !onMail;
  if (onMail) return;

  let left = '<span></span>', title = `<span>${TAB_TITLES[tab]}</span>`, tools = phoneBtn(), seg = '', body = '';
  // WhatsApp's back button is just the arrow, like WhatsApp; the others show where they go back to.
  const backBtn = (label, shown = label) => `<button class="ios-back" id="commsBack" aria-label="Back to ${label}">${ic('chevron-left', 20)}${shown}</button>`;
  if (page === 'thread') {
    const { channel, number } = view.thread, leadId = leadIdOf(number);
    left = channel === 'wa' ? backBtn('Chats', '') : backBtn('Messages');
    title = channel === 'wa' ? waHead(leadId, number) : `${avatarOf(leadId)}<span>${esc(nameOf(leadId, number))}</span>`;
    tools = `<button class="ios-icon" data-call="${number}" title="Call ${fmtPhone(number)}" aria-label="Call ${fmtPhone(number)}">${ic('phone', 17)}</button>${phoneBtn()}`;
    body = chatHtml(channel, number);
  } else if (page === 'contacts') {
    left = backBtn(TAB_TITLES[tab]);
    title = '<span>Contacts</span>';
    seg = `<label class="ios-search">${ic('search', 15)}<input id="contactSearch" type="search" placeholder="Search" autocomplete="off" aria-label="Search contacts" value="${esc(view.query)}"></label>`;
    body = contactsHtml();
  } else if (page === 'contact') {
    left = backBtn('Contacts');
    title = '<span></span>';
    body = contactCardHtml(leads.find(l => l.id === view.contactId));
  } else if (tab === 'all') {
    body = [...threadsOf().map(t => ({ at: t.last.at, thread: t })), ...shownCalls().map(c => ({ at: c.at, call: c })),
      ...mail.recent().map(m => ({ at: m.at, mail: m }))]
      .sort((a, b) => b.at - a.at).map(allRow).join('') || '<div class="ios-empty">Nothing yet.</div>';
  } else if (tab === 'msgs') {
    seg = `<div class="ios-seg" role="tablist"><button data-msgs="text" class="${view.msgs === 'text' ? 'on' : ''}">Messages</button><button data-msgs="wa" class="${view.msgs === 'wa' ? 'on' : ''}">WhatsApp</button></div>`;
    body = threadsOf(view.msgs).map(t => threadRow(t, view.msgs)).join('') || '<div class="ios-empty">No conversations yet.</div>';
  } else {
    seg = `<div class="ios-seg" role="tablist"><button data-calls="all" class="${view.calls === 'all' ? 'on' : ''}">All</button><button data-calls="missed" class="${view.calls === 'missed' ? 'on' : ''}">Missed</button></div>`;
    body = shownCalls().filter(c => view.calls === 'all' || c.dir === 'missed').sort((a, b) => b.at - a.at).map(callRow).join('') || '<div class="ios-empty">No calls.</div>';
  }

  $('commsNav').className = 'ios-nav' + (page === 'thread' && view.thread.channel === 'wa' ? ' wa' : '');
  $('commsNav').innerHTML = `${left}<div class="${page === 'thread' && view.thread.channel === 'wa' ? 'wa-head' : 'ios-title'}">${title}</div><div class="ios-tools">${tools}</div>`;
  $('commsSeg').innerHTML = seg;
  $('commsBody').innerHTML = body;
  updateZoneClocks();

  const composer = $('composer'), inThread = page === 'thread';
  composer.hidden = !inThread;
  if (inThread) {
    const { channel, number } = view.thread, look = channel === 'wa' ? 'wa' : serviceOf(number);
    composer.className = 'composer ' + look;
    $('composerInput').placeholder = look === 'wa' ? 'Message' : look === 'imessage' ? 'iMessage' : 'Text Message';
    const idea = threadSuggestion();
    $('cmpSuggest').innerHTML = idea ? `<button class="suggest-chip" data-suggest title="Use this reply"><b>✨ Suggested</b><span>${esc(idea)}</span></button>` : '';
    $('commsBody').scrollTop = $('commsBody').scrollHeight;
  }
  // Re-drawing must not steal the cursor from a field being typed in.
  const el = focusId && $(focusId);
  if (el && document.activeElement !== el) { el.focus(); if (el.matches('textarea, input[type="text"], input[type="search"]')) el.setSelectionRange(el.value.length, el.value.length); }
}


// ── PANEL 3 · CLICKS ──
$('commsTabs').addEventListener('click', e => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) setTab(tabBtn.dataset.tab);
});
$('contactsBtn').addEventListener('click', () => { if (view.page !== 'contacts') go({ page: 'contacts', query: '' }); $('contactSearch').focus(); });
$('dialerToggle').addEventListener('click', () => setOpen(!dialerOpen));
$('commsNav').addEventListener('click', e => {
  if (e.target.closest('#commsBack')) goBack();
  else if (e.target.closest('#phoneBtn')) {
    const anchor = $('phoneBtn');
    if (popAnchor === anchor) { closePop(); return; }
    openPop(anchor, phoneItems(), { list: true });
  }
});
$('commsSeg').addEventListener('click', e => {
  const m = e.target.closest('[data-msgs]'), c = e.target.closest('[data-calls]');
  if (m) { view.msgs = m.dataset.msgs; renderComms(); }
  if (c) { view.calls = c.dataset.calls; renderComms(); }
});
$('commsSeg').addEventListener('input', e => {
  if (e.target.id !== 'contactSearch') return;
  view.query = e.target.value;
  $('commsBody').innerHTML = contactsHtml();
});
$('comms').addEventListener('click', e => {
  const text = e.target.closest('[data-text]');
  if (text) { openText(text.dataset.text); return; }
  const thread = e.target.closest('[data-thread]');
  if (thread) { const lead = leadByNumber(thread.dataset.number); if (lead && lead.id !== selectedId) selectLead(lead.id); openThread(thread.dataset.thread, thread.dataset.number); return; }
  const call = e.target.closest('[data-call]');
  if (call) { callNumber(call.dataset.call); return; }
  const openCall = e.target.closest('[data-open-call]');
  if (openCall) { showNumber(openCall.dataset.openCall); return; }
  const contact = e.target.closest('[data-contact]');
  if (contact) { go({ page: 'contact', contactId: Number(contact.dataset.contact) }); return; }
  const l = leads.find(x => x.id === view.contactId);
  const cardAct = e.target.closest('[data-card-act]');
  if (cardAct) { const kind = cardAct.dataset.cardAct, value = actTarget(kind, l); value ? runAct(kind, value, l) : openPicker(kind, cardAct, l); return; }
  const photo = e.target.closest('[data-photo]');
  if (photo) { if (photo.dataset.photo === 'add') $('photoInput').click(); else removePhoto(l); return; }
  const load = e.target.closest('[data-load]');
  if (load) { showNumber(load.dataset.load); return; }
  const mailBtn = e.target.closest('[data-mail]');
  if (mailBtn) { composeEmail({ to: [mailBtn.dataset.mail] }); return; }
  const mailRow = e.target.closest('[data-open-mail]');
  if (mailRow) { setTab('email'); mail.openThread(mailRow.dataset.openMail); }
});
$('comms').addEventListener('keydown', e => {
  const row = e.target.closest('[data-call][role="button"], [data-open-mail]');
  if (row && (e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); row.click(); }
});


// ── CONTACT PHOTO ──
// A photo added on a contact card is cut to a small square and kept with the lead in this browser (lead.photo).
// Every avatar for that lead shows it. A photo from WhatsApp or email, once connected, goes in the same place.
const PHOTO_PX = 160;
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight), canvas = document.createElement('canvas');
      canvas.width = canvas.height = PHOTO_PX;
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
    img.src = url;
  });
}
function savePhoto(l, photo) {
  updateLead(l.id, { photo });
  renderLeads();
  renderComms();
}
function removePhoto(l) {
  const before = l.photo;
  savePhoto(l, '');
  toast('Photo removed.', [{ label: 'Undo', run: () => savePhoto(l, before) }]);
}
$('photoInput').addEventListener('change', async e => {
  const file = e.target.files[0], l = leads.find(x => x.id === view.contactId);
  e.target.value = '';
  if (!file || !l) return;
  try { savePhoto(l, await shrinkPhoto(file)); } catch { toast('That picture can’t be opened. Try a JPG or PNG.'); }
});


// ── PANEL 3 · COMPOSER: TEXT, FILES, VOICE TYPING ──
const composerInput = $('composerInput');
let pendingFiles = [];
function renderFiles() {
  $('cmpFiles').innerHTML = pendingFiles.map((f, i) => `<span class="file-chip">${ic(f.type.startsWith('image/') ? 'image' : 'file', 12)}<span>${esc(f.name)} · ${fmtSize(f.size)}</span><button data-remove="${i}" title="Remove" aria-label="Remove ${esc(f.name)}">${ic('x', 10)}</button></span>`).join('');
}
function growInput() {
  composerInput.style.height = 'auto';
  composerInput.style.height = composerInput.scrollHeight + 'px';
}
function sendFromComposer() {
  const text = composerInput.value.trim();
  if (!text && !pendingFiles.length) { composerInput.focus(); return; }
  const { channel, number } = view.thread;
  if (!sendMessage(channel, number, text, pendingFiles)) { toast(`Not sent — ${phoneEngine.activePhone().name} is not connected.`); return; }
  composerInput.value = '';
  pendingFiles = [];
  renderFiles();
  growInput();
}
composerInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFromComposer(); } });
composerInput.addEventListener('input', growInput);
$('sendBtn').addEventListener('click', sendFromComposer);
$('attachBtn').addEventListener('click', () => $('attachInput').click());
$('attachInput').addEventListener('change', e => { pendingFiles.push(...e.target.files); e.target.value = ''; renderFiles(); composerInput.focus(); });
$('cmpSuggest').addEventListener('click', e => {
  const chip = e.target.closest('[data-suggest]');
  if (!chip) return;
  composerInput.value = chip.querySelector('span').textContent;
  growInput();
  composerInput.focus();
});
$('cmpFiles').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b) { pendingFiles.splice(Number(b.dataset.remove), 1); renderFiles(); } });

// Voice typing uses the browser's speech recognition (Chrome, Edge, Safari).
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
let dictation = null;
$('micBtn').addEventListener('click', () => {
  if (dictation) { dictation.stop(); return; }
  if (!Speech) { toast('Voice typing works in Chrome, Edge and Safari.'); return; }
  const base = composerInput.value.trim();
  dictation = new Speech();
  dictation.lang = 'en-US';
  dictation.interimResults = true;
  dictation.onresult = e => {
    composerInput.value = (base ? base + ' ' : '') + [...e.results].map(r => r[0].transcript).join('');
    growInput();
  };
  dictation.onerror = e => toast(e.error === 'not-allowed' ? 'Microphone access is blocked.' : 'Voice typing stopped.');
  dictation.onend = () => { dictation = null; $('micBtn').classList.remove('on'); };
  $('micBtn').classList.add('on');
  toast('Listening… tap the mic to stop.');
  try { dictation.start(); } catch { dictation = null; $('micBtn').classList.remove('on'); toast('Voice typing could not start.'); }
});


// ── WRITING HELP ──
// Suggested replies are picked from what the message says. A real AI service can write these later.
const REPLY_RULES = [
  [/move|reschedul|push (it|our)/i, m => `Yes, ${(m.match(/\d{1,2}(:\d{2})?\s?(AM|PM)( on \w+)?/i) || ['that'])[0]} works for me. I’ll send an updated invite.`],
  [/pen test|soc ?2|security/i, () => 'Thanks! That’s great. As soon as it’s in, I’ll wrap up the security review.'],
  [/volume discount|pricing|price|quote/i, () => 'Yes, the volume discount is included. I’ll send the final numbers over today.'],
  [/timeline|setup|implementation|how long/i, () => 'Most teams are live in about 2 weeks. Happy to walk you through the plan on a quick call.'],
  [/payment|signing|due/i, () => 'Good question. The first payment is due 30 days after signing, not at signing.'],
  [/demo|works|confirm/i, () => 'Perfect, see you then. I’ll send the agenda beforehand.'],
  [/test passed|passed/i, () => 'Great news! Want to set up a quick call to go over next steps?'],
  [/thank/i, () => 'You’re very welcome! Let me know if you need anything else.']
];
function suggestReply({ kind, text = '', lead }) {
  const first = lead ? lead.first : '';
  const rule = REPLY_RULES.find(([re]) => re.test(text));
  const line = rule ? rule[1](text)
    : kind === 'call' ? `Sorry I missed your call${first ? ', ' + first : ''}. When is a good time to reach you?`
    : `Thanks${first ? ', ' + first : ''}! I’ll get back to you shortly.`;
  return line;
}
// Writes a whole email from a short instruction, like “tell Ray I’m working on his file” or “ask Mei to sign by Friday”.
// In the instruction, “you” is the person writing and “he / she / his / her” is the person the email goes to.
// It runs on this computer from the instruction’s own words; an AI service can take its place later with the same inputs and output.
function writeFromPrompt(prompt, { name = '', tone = 'professional', length = 'medium', sender = '' } = {}) {
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const titleCase = s => s.split(/\s+/).map(cap).join(' ');
  const NOT_NAMES = /^(him|her|them|me|us|the|a|an|my|our|that|to|about|everyone|everybody|someone|client|customer)$/i;
  let text = prompt.trim().replace(/\s+/g, ' ').replace(/[.!\s]+$/, '')
    .replace(/\b(in|by|via|through) (an? )?(e-?mail|message|note)\b/gi, '').replace(/\s+/g, ' ').trim();
  let intent = 'tell', who = '', rest = text, m;
  const VERBS = { tell: 'tell', let: 'tell', inform: 'tell', notify: 'tell', update: 'tell', ask: 'ask', remind: 'remind', thank: 'thank', invite: 'invite', 'follow up with': 'follow', 'check in with': 'follow' };
  // A name is the word after the verb, plus a last name when the next word is written with a capital letter.
  const takeName = (first, after) => {
    const last = after.match(/^([A-Z][a-z'-]+)\b\s*(.*)$/);
    return last && !/^(I|I'm|I'll|I've|In|That|To|On|About|For|And)$/.test(last[1]) ? [first + ' ' + last[1], last[2]] : [first, after];
  };
  if ((m = text.match(/^(?:please\s+)?(tell|let|inform|notify|update|ask|remind|thank|invite|follow up with|check in with)\s+([\w'-]+)\s*(.*)$/i)) && !NOT_NAMES.test(m[2])) {
    intent = VERBS[m[1].toLowerCase()];
    [who, rest] = takeName(m[2], m[3]);
    rest = rest.replace(/^know\b\s*/i, '');
  } else if ((m = text.match(/^(?:please\s+)?(?:(?:write|send|draft|compose)\s+(?:an?\s+)?(?:quick\s+|short\s+)?(?:e-?mail|message|note)\s+to|e-?mail|message|write to)\s+([\w'-]+)\s*[,:]?\s*(.*)$/i)) && !NOT_NAMES.test(m[1])) {
    [who, rest] = takeName(m[1], m[2]);
    rest = rest.replace(/^[,:]\s*/, '').replace(/^(saying|to say|and say|telling (him|her|them)|that)\s+/i, '');
    const sub = rest.match(/^(asking|ask|reminding|remind|thanking|thank|inviting|invite)\s+(?:(?:him|her|them)\s+)?(.*)$/i);
    if (sub) { intent = { ask: 'ask', asking: 'ask', remind: 'remind', reminding: 'remind', thank: 'thank', thanking: 'thank', invite: 'invite', inviting: 'invite' }[sub[1].toLowerCase()]; rest = sub[2]; }
  } else rest = text.replace(/^(?:please\s+)?(?:write|send|draft|compose)\s+(?:an?\s+)?(?:quick\s+|short\s+)?(?:e-?mail|message|note)\s*(?:saying|about|that)?\s*/i, '');
  who = who ? titleCase(who) : name;
  rest = rest.replace(/^(that|saying)\s+/i, '');

  // Swap who is who: the recipient (he, she, him, his, her, their name) becomes “you”; the writer (“you”) becomes “I” or “me”.
  // Placeholders keep the two swaps from undoing each other: \u0002 = you, \u0003 = your, \u0004 = yourself.
  const third = s => s
    .replace(/\b(he|she) (is|was|has|does|isn't|wasn't|hasn't|doesn't)\b/gi, (_, p, v) => '\u0002 ' + { is: 'are', was: 'were', has: 'have', does: 'do', "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't", "doesn't": "don't" }[v.toLowerCase()])
    .replace(/\b(he|she)'s\b/gi, "\u0002're").replace(/\b(he|she)'ll\b/gi, "\u0002'll").replace(/\b(he|she)'d\b/gi, "\u0002'd")
    .replace(/\b(he|she) (\w+)/gi, (_, p, v) => '\u0002 ' + (/^(will|would|can|could|should|must|might|may|did|had)$/i.test(v) ? v : v.replace(/ies$/, 'y').replace(/(ss|sh|ch|x|o)es$/, '$1').replace(/([^s])s$/, '$1')))
    .replace(/\b(he|she|him)\b/gi, '\u0002').replace(/\b(himself|herself)\b/gi, '\u0004').replace(/\bhis\b/gi, '\u0003')
    .replace(/\bher\b(\s+(\w+))?/gi, (all, sp, next) => next && !/^(the|a|an|to|that|this|it|and|or|for|with|about|know|if|when|by|on|in|at|up|back|again|today|tomorrow|now|soon)$/.test(next) ? '\u0003' + sp : '\u0002' + (sp || ''));
  const second = s => s
    .replace(/\byou are\b/gi, 'I am').replace(/\byou're\b/gi, "I'm").replace(/\byou were\b/gi, 'I was').replace(/\byou've\b/gi, "I've").replace(/\byou'll\b/gi, "I'll").replace(/\byou'd\b/gi, "I'd")
    .replace(/\byourself\b/gi, 'myself').replace(/\byours\b/gi, 'mine').replace(/\byour\b/gi, 'my')
    .replace(/(^|\b(\w+)\s+)you\b/gi, (all, lead, prev) => lead + (!prev || /^(that|and|but|if|when|because|so|since|as|while|until|or|once)$/i.test(prev) ? 'I' : 'me'));
  if (who) { const first = who.split(' ')[0]; rest = rest.replace(new RegExp(`\\b${first}'s\\b`, 'gi'), '\u0003').replace(new RegExp(`\\b${first}\\b`, 'gi'), '\u0002'); }
  rest = second(third(rest)).replace(/\u0002/g, 'you').replace(/\u0003/g, 'your').replace(/\u0004/g, 'yourself').replace(/\bi\b/g, 'I').trim();

  const formal = tone === 'formal';
  const expand = s => !formal ? s : s.replace(/\bI'm\b/g, 'I am').replace(/\bI'll\b/g, 'I will').replace(/\bI've\b/g, 'I have').replace(/\bI'd\b/g, 'I would').replace(/\byou're\b/gi, 'you are').replace(/\byou'll\b/gi, 'you will')
    .replace(/\bdon't\b/gi, 'do not').replace(/\bcan't\b/gi, 'cannot').replace(/\bwon't\b/gi, 'will not').replace(/\bit's\b/gi, 'it is').replace(/\baren't\b/gi, 'are not').replace(/\bisn't\b/gi, 'is not');
  const bare = rest.replace(/^(to|about|that|on|for|regarding)\s+/i, '');
  const L = {
    tell: { professional: `I wanted to let you know that ${rest}.`, friendly: `Just a quick note to let you know that ${rest}!`, formal: `I am writing to let you know that ${rest}.`, short: `${cap(rest)}.` },
    ask: /^(if|whether|when|what|where|how|why|who)\b/i.test(bare)
      ? { professional: `Could you let me know ${bare}?`, friendly: `Could you let me know ${bare}?`, formal: `Would you kindly let me know ${bare}?`, short: `Can you let me know ${bare}?` }
      : { professional: `Could you please ${bare}?`, friendly: `Could you ${bare}?`, formal: `Would you kindly ${bare}?`, short: `Please ${bare}.` },
    remind: { professional: `Just a friendly reminder ${/^(to|about)\s/i.test(rest) ? rest : 'that ' + bare}.`, friendly: `Quick reminder ${/^(to|about)\s/i.test(rest) ? rest : 'that ' + bare}!`, formal: `This is a reminder ${/^(to|about)\s/i.test(rest) ? rest : 'that ' + bare}.`, short: `Reminder: ${bare}.` },
    thank: { professional: `Thank you ${/^for\s/i.test(rest) ? rest : 'for ' + bare}.`, friendly: `Thanks so much ${/^for\s/i.test(rest) ? rest : 'for ' + bare}!`, formal: `Thank you very much ${/^for\s/i.test(rest) ? rest : 'for ' + bare}.`, short: `Thanks ${/^for\s/i.test(rest) ? rest : 'for ' + bare}.` },
    invite: { professional: `I'd like to invite you ${/^to\s/i.test(rest) ? rest : 'to ' + bare}.`, friendly: `I'd love to invite you ${/^to\s/i.test(rest) ? rest : 'to ' + bare}!`, formal: `I would like to invite you ${/^to\s/i.test(rest) ? rest : 'to ' + bare}.`, short: `You're invited ${/^to\s/i.test(rest) ? rest : 'to ' + bare}.` },
    follow: { professional: `I wanted to follow up ${/^(on|about|regarding)\s/i.test(rest) ? rest : 'on ' + bare}.`, friendly: `Just checking in ${/^(on|about|regarding)\s/i.test(rest) ? rest : 'on ' + bare}!`, formal: `I am writing to follow up ${/^(on|about|regarding)\s/i.test(rest) ? rest : 'on ' + bare}.`, short: `Following up ${/^(on|about|regarding)\s/i.test(rest) ? rest : 'on ' + bare}.` }
  };
  const core = rest ? L[intent][tone] : { professional: 'I wanted to reach out.', friendly: 'Just wanted to reach out!', formal: 'I am writing to reach out to you.', short: 'Reaching out.' }[tone];
  const opener = { professional: "I hope you're doing well.", friendly: 'Hope your week is going great!', formal: 'I hope this message finds you well.', short: '' }[tone];
  const extra = { tell: "I'll keep you posted as things move forward.", ask: 'Having this will help me keep everything on track.', remind: 'Please let me know if anything has changed.', thank: 'I really appreciate it.', invite: 'Please let me know if that works for you.', follow: "I'm happy to answer any questions you might have." }[intent];
  const closer = { professional: 'Please let me know if you have any questions.', friendly: 'Let me know if you need anything!', formal: 'Please do not hesitate to contact me with any questions.', short: '' }[tone];
  const greet = { professional: `Hi ${who || 'there'},`, friendly: `Hey ${who || 'there'},`, formal: who ? `Dear ${who},` : 'Hello,', short: who ? `${who},` : 'Hi,' }[tone];
  const signOff = { professional: 'Best regards,', friendly: 'Thanks!', formal: 'Sincerely,', short: 'Thanks,' }[tone];
  const body = [length !== 'short' && opener, core, length === 'long' && tone !== 'short' && extra, length !== 'short' && closer].filter(Boolean).join(' ');
  const text2 = expand([greet, '', body, ...(sender ? ['', signOff, sender] : [])].join('\n')).replace(/\s+([.!?,])/g, '$1').replace(/([.!?])[.!?]+/g, '$1');

  const words = s => s.replace(/[.!?]+$/, '').split(/\s+/).slice(0, 6).join(' ');
  const yours = ((rest.match(/\byour\s+([\w-]+)(\s+[\w-]+)?/i) || []).slice(1).filter(Boolean).join('').split(/\s+/).filter((w, i) => !i || !/^(is|are|was|were|has|have|will|by|for|to|and|or|ready|done|today|tomorrow|now|soon|on|in|at|with|from|as|so)$/i.test(w)).join(' '));
  const subject = !rest ? 'Reaching out' : {
    tell: yours ? `Update on your ${yours}` : `Update: ${cap(words(bare))}`,
    ask: 'Quick question', remind: `Reminder: ${cap(words(bare))}`, thank: 'Thank you', invite: `Invitation: ${cap(words(bare))}`, follow: `Following up: ${cap(words(bare))}`
  }[intent];
  return { subject, text: text2 };
}
function threadSuggestion() {
  if (view.page !== 'thread') return '';
  const list = threadMessages(view.thread.channel, view.thread.number), last = list[list.length - 1];
  return last && last.dir === 'in' ? suggestReply({ kind: 'text', text: last.text, lead: leads.find(l => l.id === last.leadId) }) : '';
}


// ── ADD LEAD WINDOW ──
const modal = $('leadModal'), form = $('leadForm');
const closeModal = () => modal.classList.remove('open');
// Anything typed in the Add Lead window that has not been added yet.
const leadFormTyped = () => modal.classList.contains('open') && [...form.querySelectorAll('input')].some(el => el.value.trim());
// Cancel, a click outside and Esc ask first when something was typed, so it is never lost by accident.
async function leaveModal() {
  if (leadFormTyped() && !await ask({ title: 'Discard this lead?', text: 'What you typed has not been added and will be lost.', ok: 'Discard', danger: true })) return;
  closeModal();
}

$('addLeadBtn').addEventListener('click', () => {
  form.reset();
  $('leadError').textContent = '';
  modal.classList.add('open');
  $('fCompany').focus();
});
$('leadCancel').addEventListener('click', leaveModal);
modal.addEventListener('mousedown', e => { if (e.target === modal) leaveModal(); });

form.addEventListener('submit', e => {
  e.preventDefault();
  const val = id => $(id).value.trim();
  const company = val('fCompany'), first = val('fFirst'), last = val('fLast'), revenueText = val('fRevenue'), phone = val('fPhone'), email = val('fEmail');
  const revenue = Number(revenueText.replace(/[$,\s]/g, ''));
  const error = !company ? 'Enter the company name.'
    : !first || !last ? 'Enter the first and last name.'
    : !revenueText || !Number.isFinite(revenue) || revenue < 0 ? 'Enter the revenue as a number, like 240000.'
    : phone && !/^1?\d{10}$/.test(digitsOf(phone)) ? 'Enter a 10-digit mobile number, like (305) 555-5555.'
    : email && !/^\S+@\S+\.\S+$/.test(email) ? 'Enter a valid email address.'
    : '';
  if (error) { $('leadError').textContent = error; return; }

  const lead = {
    id: Date.now(), custom: true, company, legal: '', dba: '', ein: '', industry: '', started: '',
    first, last, dob: '', ssn: '', address: '', applied: '', status: 'NEW', rep: user.name, addedBy: user.name, stage: 'prospecting', value: revenue, prob: 10, closeDate: '—', lastActive: Date.now(),
    phones: phone ? [{ type: 'mobile', num: digitsOf(toDial(phone)).slice(-10) }] : [], emails: email ? [email] : [], touch: {},
    bank: null, notes: '', history: []
  };
  store.write('nv.leads', [lead, ...leads.filter(l => l.custom)]);
  leads.unshift(lead);
  closeModal();
  query = '';
  $('globalSearch').value = '';
  renderLeads();
  selectLead(lead.id);
  $('leadList').scrollTop = 0;
});


// ── SEARCH + LIST CLICKS ──
$('globalSearch').addEventListener('input', e => { query = e.target.value; renderLeads(); });
$('leadList').addEventListener('click', e => {
  const row = e.target.closest('.lead-row');
  if (row) selectLead(Number(row.dataset.id));
});
onMinute(() => { renderLeads(); updateZoneClocks(); });
