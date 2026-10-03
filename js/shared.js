// ── HELPERS ──
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Sizes follow the page's root font size (Screen fit). A design size n is written as it looks at 16px to 1rem.
const rem = n => n / 16 + 'rem';
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize);
const ic = (name, size = 12) => `<svg class="ic" width="${rem(size)}" height="${rem(size)}"><use href="#i-${name}"/></svg>`;
// Filled icons (the m- symbols), used by Email, Campaign, Scanner and the lead list's email checks. width: for a wide icon.
const mi = (name, size = 16, width = size) => `<svg class="mi" width="${rem(width)}" height="${rem(size)}" aria-hidden="true"><use href="#m-${name}"/></svg>`;
const money = n => '$' + Math.round(n).toLocaleString('en-US');
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const digitsOf = s => String(s).replace(/\D/g, '');
const ago = minutes => Date.now() - minutes * 60000;
// Sample content lives in sample-data.js. Each page asks for its part here; without that file every part is empty.
const sample = (key, empty) => (window.SAMPLE_DATA || {})[key] ?? empty;

// People always see numbers as (305) 555-5555. The phone system dials them as +13055555555.
function fmtPhone(n) {
  let d = digitsOf(n);
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n);
}
function toDial(n) {
  const d = digitsOf(n);
  return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : String(n).trim();
}

// ── TIME ──
// Every date and time on screen is Eastern time, 12-hour (3:45 PM), whatever zone the computer is in.
// All of it is worked out here. A lead's own local time (Company Info) is the one other zone shown.
const ZONE = 'America/New_York';
const timeFormats = new Map();
function timeFormat(opts, zone = ZONE) {
  const key = zone + JSON.stringify(opts);
  if (!timeFormats.has(key)) timeFormats.set(key, new Intl.DateTimeFormat('en-US', { timeZone: zone, ...opts }));
  return timeFormats.get(key);
}
const showTime = (ts, opts, zone) => timeFormat(opts, zone).format(ts);
const clockTime = (ts, zone) => showTime(ts, { hour: 'numeric', minute: '2-digit' }, zone);
// The Eastern calendar date and clock of a moment: { y, mo (0-11), d, h (0-23), mi, wd (0 = Sunday) }.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function wall(ts = Date.now()) {
  const p = Object.fromEntries(timeFormat({ year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(ts).map(x => [x.type, x.value]));
  return { y: +p.year, mo: p.month - 1, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: WEEKDAYS.indexOf(p.weekday) };
}
// The moment an Eastern date and clock happen. Days past the end of the month roll over, so d + 1 is tomorrow.
function fromWall(y, mo, d, h = 0, mi = 0) {
  const want = Date.UTC(y, mo, d, h, mi);
  const offset = t => { const w = wall(t); return Date.UTC(w.y, w.mo, w.d, w.h, w.mi) - t; };
  return want - offset(want - offset(want));
}
const dayStart = (ts = Date.now()) => { const w = wall(ts); return fromWall(w.y, w.mo, w.d); };
// Whole Eastern days from that day to today: 0 today, 1 yesterday.
function daysAgo(ts) {
  const a = wall(), b = wall(ts);
  return Math.round((Date.UTC(a.y, a.mo, a.d) - Date.UTC(b.y, b.mo, b.d)) / 86400000);
}
// Date and time boxes hold Eastern time as 2026-09-28T15:45.
const pad2 = n => String(n).padStart(2, '0');
const inputValue = ts => { const w = wall(ts); return `${w.y}-${pad2(w.mo + 1)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}`; };
function fromInput(text) {
  const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? fromWall(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
}
function dayTime(ts) {
  return (daysAgo(ts) === 0 ? 'Today' : showTime(ts, { month: 'short', day: 'numeric' })) + ' · ' + clockTime(ts);
}
// A date with no time, like a birthday (2026-09-28). It is the same day in every zone.
const isoParts = iso => iso.split('-').map(Number);
const fmtDate = iso => { const [y, m, d] = isoParts(iso); return showTime(Date.UTC(y, m - 1, d), { month: 'short', day: 'numeric', year: 'numeric' }, 'UTC'); };
function yearsSince(iso) {
  const [y, m, d] = isoParts(iso), now = wall();
  return now.y - y - (now.mo + 1 < m || (now.mo + 1 === m && now.d < d) ? 1 : 0);
}
// A row animates in once: the first time it is drawn, and only if it just happened. Redrawing never replays it.
const drawnRows = new Set();
function newRow(key, at) {
  if (drawnRows.has(key)) return '';
  drawnRows.add(key);
  return Date.now() - at < 5000 ? ' is-new' : '';
}

// short = true drops "ago" (5m, 3h, 2d, 1w, now) where space is tight, like the lead list.
function timeAgo(ts, short = false) {
  const m = Math.floor((Date.now() - ts) / 60000);
  const out = text => short ? text : text + ' ago';
  if (m < 1) return short ? 'now' : 'Just now';
  if (m < 60) return out(m + 'm');
  const h = Math.floor(m / 60);
  if (h < 24) return out(h + 'h');
  const d = Math.floor(h / 24);
  return out(d < 7 ? d + 'd' : Math.floor(d / 7) + 'w');
}


// ── TOPBAR CLOCK ──
// Eastern time on top, the date under it. One timer, on the minute, also runs everything else that shows the time.
const minuteJobs = [];
const onMinute = job => minuteJobs.push(job);
(() => {
  const el = $('topClock');
  let timer = 0;
  function draw() {
    const now = Date.now();
    el.dateTime = new Date(now).toISOString();
    $('clockTime').textContent = clockTime(now);
    $('clockDate').textContent = showTime(now, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function tick() {
    draw();
    minuteJobs.forEach(job => job());
    wait();
  }
  function wait() {
    clearTimeout(timer);
    timer = setTimeout(tick, 60000 - Date.now() % 60000 + 20);
  }
  // A hidden tab's timers run late; catch up as soon as it is back.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  draw();
  wait();
})();

// ── WHO IS SIGNED IN ──
// There is no login yet, so the signed-in rep is set on this one line. The login system will set it later.
const SIGNED_IN = 'Sam';
// Sam owns the company and is also a rep, with his own leads and work like any rep.
const OWNER = 'Sam';
const user = { name: SIGNED_IN };
const isOwner = user.name === OWNER;
// The team (full names and titles) comes from sample-data.js until the login system provides it.
// That file loads after this one, so it is read when needed.
const team = () => sample('team', []);
const person = name => team().find(r => r.name === name) || { name, full: name || 'No rep', title: '' };
const repNames = () => team().length ? team().map(r => r.name) : [...new Set(leads.map(l => l.rep).filter(Boolean))];
// First and last initial: "Mary Ann Smith" is MS.
const initials = name => { const w = String(name).trim().split(/\s+/).filter(Boolean); return ((w[0] || '')[0] || '') + (w.length > 1 ? w[w.length - 1][0] : ''); };

// ── AVATARS ──
// One round picture for a person everywhere in the CRM: their photo when there is one, otherwise their initials
// (a person icon when there is no name). size: '' (32px), 'sm', 'md', 'lg' or 'xl'. tint: a colour in place of grey.
function avatar(name, { photo = '', size = '', tint = '', letters = 2 } = {}) {
  const cls = 'avatar' + (size ? ' ' + size : '');
  if (photo) return `<span class="${cls}"><img src="${esc(photo)}" alt=""></span>`;
  const text = initials(name).slice(0, letters).toUpperCase();
  return `<span class="${cls}"${tint ? ` style="--tint:${esc(tint)}"` : ''}>${text ? esc(text) : ic('user', size === 'sm' ? 14 : 20)}</span>`;
}

function renderSidebarUser() {
  const me = person(user.name);
  $('sidebarAvatar').innerHTML = avatar(me.full, { size: 'sm', tint: 'var(--accent-blue)' });
  $('sidebarName').textContent = me.full;
  $('sidebarRole').textContent = me.title;
}

// ── MY WORK / ALL REPS ──
// Reps see only their own leads, messages, mail and activity. The owner also gets a switch at the top of the Leads, Email
// and Activity Log pages: My work (his own, like any rep) or All reps (every rep's, plus leads with no rep). It starts on My work.
let workScope = 'mine';
const canSee = rep => rep === user.name || (isOwner && workScope === 'all');
const workSwitch = $('workScope');
function renderWorkSwitch() {
  if (!workSwitch) return;
  workSwitch.querySelectorAll('[data-work]').forEach(b => {
    const on = b.dataset.work === workScope;
    b.setAttribute('aria-checked', on);
    b.tabIndex = on ? 0 : -1;
  });
}
function setWorkScope(value) {
  if (value === workScope) return;
  workScope = value;
  renderWorkSwitch();
  refitLeads();
  mail.refit();
  renderNotifs();
  if (page === 'dash') dashboard.render();
  if (page === 'camp') campaign.render();
  if (page === 'log') activityLog.render();
}
if (workSwitch) workSwitch.addEventListener('click', e => { const b = e.target.closest('[data-work]'); if (b) setWorkScope(b.dataset.work); });
renderWorkSwitch();

// Arrow keys move between the options of any switch.
document.addEventListener('keydown', e => {
  const b = e.target.closest('.seg [role="radio"]');
  if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const all = [...b.parentElement.children], next = all[(all.indexOf(b) + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + all.length) % all.length];
  next.click();
  // A switch drawn again by the click has new buttons; data-key finds the same option.
  ((next.dataset.key && document.querySelector(`[data-key="${next.dataset.key}"]`)) || next).focus();
});


// ── SCROLLBARS ──
// Every scrollbar stays hidden. One shows only after the mouse rests right on it for 1 second, and hides again when the
// mouse leaves it — being inside the panel is not enough. Wheel, trackpad and keyboard scrolling always work.
// The one exception is a box marked .scroll-always (the Scanner tables), whose scrollbars always show.
// Touch screens have no hover, so scrollbars never show there; swiping still scrolls.
(() => {
  const WAIT = 1000, FADE = 150;
  let timer = 0, over = null, shown = null;
  // Is the point on el's own scrollbar strip (the part right of or below its content)?
  function onBar(el, x, y) {
    const r = el.getBoundingClientRect(), left = r.left + el.clientLeft, top = r.top + el.clientTop;
    const bar = (size, inner) => size - inner > el.clientLeft * 2 + 1;
    return (el.scrollHeight > el.clientHeight && bar(el.offsetWidth, el.clientWidth) && x >= left + el.clientWidth && x < r.right - el.clientLeft)
      || (el.scrollWidth > el.clientWidth && bar(el.offsetHeight, el.clientHeight) && y >= top + el.clientHeight && y < r.bottom - el.clientTop);
  }
  function hide() {
    if (!shown) return;
    const el = shown;
    shown = null;
    el.classList.replace('scroll-show', 'scroll-hide');
    setTimeout(() => el.classList.remove('scroll-hide'), FADE);
  }
  document.addEventListener('pointermove', e => {
    // While a button is held (dragging a scrollbar), the scrollbar stays as it is.
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const el = e.target instanceof Element && onBar(e.target, e.clientX, e.clientY) ? e.target : null;
    if (el === over) return;
    over = el;
    clearTimeout(timer);
    if (el !== shown) hide();
    if (el && el !== shown) timer = setTimeout(() => { shown = el; el.classList.remove('scroll-hide'); el.classList.add('scroll-show'); }, WAIT);
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => { over = null; clearTimeout(timer); hide(); });
})();


// ── MESSAGES (bottom left, like Gmail) ──
// One dark bar for every short message in the CRM. actions: [{ label, run }], like Undo. It shows as a popover, so it
// sits above any open window (Settings too). A new message replaces the one showing.
const toastEl = $('toast');
let toastTimer = 0, toastActions = [];
function toast(text, actions = [], ms = actions.length ? 10000 : 5000) {
  toastActions = actions;
  toastEl.innerHTML = `<span>${esc(text)}</span>${actions.map((a, i) => `<button class="toast-btn" type="button" data-toast="${i}">${esc(a.label)}</button>`).join('')}<button class="toast-x" type="button" data-toast="x" title="Close" aria-label="Close">${mi('close', 18)}</button>`;
  if (toastEl.matches(':popover-open')) toastEl.hidePopover();
  toastEl.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  clearTimeout(toastTimer);
  if (toastEl.matches(':popover-open')) toastEl.hidePopover();
}
toastEl.addEventListener('click', e => {
  const b = e.target.closest('[data-toast]');
  if (!b) return;
  hideToast();
  if (b.dataset.toast !== 'x') toastActions[Number(b.dataset.toast)].run();
});
// The browser refused to save (full, or saving is blocked): said once, the first time it happens.
addEventListener('savefail', () => toast('This browser can’t save changes right now. What you do stays until the CRM is closed.', [], 8000), { once: true });

// ── ASK FIRST ──
// The one yes/no window, used only for what can't be undone. Everything else happens at once with Undo.
// ok: the button's word ('Delete', 'Discard'…); with no ok the window only has Close. html: a body that is already safe HTML.
// Resolves true when the ok button was pressed.
const askBox = $('askBox');
function ask({ title, text = '', html = '', ok = '', danger = false }) {
  askBox.innerHTML = `<h2 class="modal-head" id="askTitle">${esc(title)}</h2><div class="ask-text">${html || esc(text)}</div>
    <div class="modal-foot">${ok ? `<button class="btn" type="button" value="">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" type="button" value="ok">${esc(ok)}</button>`
      : '<button class="btn primary" type="button" value="">Close</button>'}</div>`;
  askBox.returnValue = '';
  askBox.showModal();
  // A delete starts on Cancel, so Enter never removes anything by accident.
  askBox.querySelector(danger ? '.btn' : '.modal-foot .btn:last-child').focus();
  return new Promise(resolve => askBox.addEventListener('close', () => resolve(askBox.returnValue === 'ok'), { once: true }));
}
askBox.addEventListener('click', e => { const b = e.target.closest('button[value]'); if (b) askBox.close(b.value); });
askBox.addEventListener('mousedown', e => { if (e.target === askBox) askBox.close(''); });
// Keys pressed in the window stay in it, so page shortcuts never fire behind it.
askBox.addEventListener('keydown', e => e.stopPropagation());


// ── WORK LOG ──
// Every real action a rep takes — a call, a text, a WhatsApp message, opening a lead, a note — is saved here with who
// did it and when. The Activity Log works out working time and last actions from it. Emails are kept with the mail itself.
// It keeps the last 8 days in this browser. Seeing every rep's work from any computer needs a shared server later.
const workLog = (() => {
  const KEEP = 8 * 86400000;
  const list = store.read('nv.workLog', []).filter(a => Date.now() - a.at < KEEP);
  return {
    list,
    add(kind, fields = {}) {
      list.push({ kind, by: user.name, at: Date.now(), ...fields });
      store.write('nv.workLog', list);
    }
  };
})();


// ── PAGES ──
// The sidebar switches between the pages. The mail screen sits on the Email page, or else in Panel 3.
let page = 'leads';
function showPage(name) {
  if (name === page) return;
  page = name;
  closePop();
  document.body.dataset.page = name;
  $('leadsPage').hidden = name !== 'leads';
  $('mailPage').hidden = name !== 'mail';
  $('dashPage').hidden = name !== 'dash';
  $('scanPage').hidden = name !== 'scan';
  $('campPage').hidden = name !== 'camp';
  $('logPage').hidden = name !== 'log';
  document.querySelectorAll('.nav-item[data-page]').forEach(b => {
    b.classList.toggle('active', b.dataset.page === name);
    b.setAttribute('aria-current', b.dataset.page === name ? 'page' : 'false');
  });
  if (name === 'dash') dashboard.render();
  if (name === 'camp') campaign.render();
  if (name === 'log') activityLog.render();
  if (name === 'mail') mail.mount($('mailPage'), 'full');
  else { mail.mount($('mailHostComms'), 'compact'); renderComms(); }
}
// ── SIDEBAR SIZE ──
// Clicking the logo switches the sidebar between full and icons only.
// With icons only, a page's name shows when the mouse rests on its icon.
function renderNav() {
  const small = document.documentElement.dataset.nav === 'small';
  $('navToggle').setAttribute('aria-expanded', !small);
  document.querySelectorAll('.nav-item').forEach(b => small ? b.setAttribute('title', b.textContent.trim()) : b.removeAttribute('title'));
}
$('navToggle').addEventListener('click', () => {
  const small = document.documentElement.dataset.nav === 'small';
  VIEW.set({ nav: small ? 'full' : 'small' });
});
addEventListener('viewchange', renderNav);
renderNav();

// ── KEYBOARD FOCUS ──
// Text boxes get a faint outline only while moving with the Tab key (shared.css); a click or tap turns it off again.
addEventListener('keydown', e => { if (e.key === 'Tab') document.documentElement.classList.add('tabbing'); }, true);
addEventListener('pointerdown', () => document.documentElement.classList.remove('tabbing'), true);

document.querySelector('.sidebar').addEventListener('click', e => {
  const b = e.target.closest('[data-page]');
  if (b) showPage(b.dataset.page);
});

// Opens a new email in the mail window. On the Leads page, Panel 3 switches to its Email tab.
function composeEmail({ to = [], bcc = [] }) {
  if (page === 'leads' && view.tab !== 'email') setTab('email');
  mail.compose({ to, bcc });
}

// Mail changes (a new email, a read, an open) refresh the parts of the Leads page that show email.
function onMailChange() {
  $('badgeEmail').textContent = mail.unreadCount() || '';
  if (view.tab === 'all' && view.page === 'list') renderComms();
  renderLeads();
  if ($('feed')) renderFeed();
}


// ── NOTIFICATIONS ──
// Each alert points at the call, message or email it is about, so nothing is typed twice.
// Sample alerts come from sample-data.js until real data is connected. New alerts come in through notify().
// Important alerts also show as a banner for a few seconds: a missed call, a text, WhatsApp or email, an email opened,
// a meeting, and a campaign reply or open. Campaign unsubscribes and STOPs only go in the list.
let notifications = [];
let unreadCount = 0;
// Email alerts need the mailbox, so the list is built once mail has loaded. Alerts whose email is gone are left out.
function buildNotifications() {
  notifications = sample('notifications', []).map(n => {
    if (n.kind === 'call') { const c = calls.find(x => x.id === n.ref); return { ...n, number: c.number, leadId: c.leadId, at: c.at }; }
    if (n.kind === 'sms' || n.kind === 'wa') { const m = messages.find(x => x.id === n.ref); return { ...n, number: m.number, leadId: m.leadId, at: m.at, text: m.text }; }
    if (n.kind === 'email') { const m = mail.latest(n.ref), lead = m && leadByEmail(m.from); return m ? { ...n, leadId: lead ? lead.id : null, at: m.at, text: m.text, subject: m.subject } : null; }
    if (n.kind === 'open') { const tr = mail.tracking(leads.find(l => l.id === n.leadId)); return tr && tr.opens.length ? { ...n, at: tr.opens[0], track: tr } : null; }
    return n;
  }).filter(Boolean).concat(reminders.alerts()).sort((a, b) => b.at - a.at);
}
const notifRead = new Set(store.read('nv.notifRead', []));
const notifState = {}; // per notification: { reply, draft, suggested }
let notifOpen = false;

const openedLine = e => `Opened “${e.subject}” · ${e.opens.length}× in total`;
const emailGist = body => { const lines = body.split('\n').map(x => x.trim()).filter(Boolean); return lines[1] || lines[0] || ''; };
const notifLead = n => leads.find(l => l.id === n.leadId);
const isImportant = n => !(n.kind === 'campaign' && (n.event === 'unsubscribed' || n.event === 'stop'));
const CAMPAIGN_LINES = {
  reply: n => `Replied to your ${n.via} campaign “${n.name}”`,
  opened: n => `Opened your campaign email “${n.name}”`,
  unsubscribed: n => `Unsubscribed from campaign email “${n.name}”`,
  stop: n => `Texted STOP to campaign “${n.name}”`
};

function notifLine(n) {
  return n.kind === 'call' ? (n.leadId ? `Missed call · ${fmtPhone(n.number)}` : 'Missed call')
    : n.kind === 'sms' ? `Text: “${n.text}”`
    : n.kind === 'wa' ? `WhatsApp: “${n.text}”`
    : n.kind === 'email' ? `Email: ${n.subject} — ${emailGist(n.text)}`
    : n.kind === 'open' ? openedLine(n.track)
    : n.kind === 'campaign' ? CAMPAIGN_LINES[n.event](n)
    : `Reminder: ${n.text}`;
}
const notifSuggestion = n => suggestReply({ kind: n.kind === 'call' ? 'call' : 'text', text: n.kind === 'email' ? emailGist(n.text) : n.text || '', lead: notifLead(n) });

const nicon = (act, icon, title) => `<button class="nicon" data-nact="${act}" title="${title}" aria-label="${title}">${ic(icon, 14)}</button>`;
const WHERE = { sms: 'Messages', call: 'Messages', wa: 'WhatsApp', email: 'Email' };
function notifActions(n) {
  const reply = nicon('reply', 'reply', n.kind === 'call' ? 'Quick text back' : 'Quick reply'), call = nicon('call', 'phone', 'Call'),
    thread = nicon('thread', 'open', `Open in ${WHERE[n.kind]}`), lead = nicon('lead', 'user', 'Open lead');
  return n.kind === 'remind' ? nicon('done', 'check', 'Done') + nicon('snooze', 'clock', 'Snooze') + lead : n.kind === 'campaign' ? (isImportant(n) ? call + lead : lead)
    : n.kind === 'open' ? call + lead : n.kind === 'email' ? reply + thread
    : n.kind === 'call' ? call + reply + thread : reply + call + thread;
}

function replyBox(n, st) {
  return `${st.suggested ? '<div class="suggested">✨ Suggested reply — edit or send</div>' : ''}
    <div class="quick-reply"><input data-reply type="text" autocomplete="off" value="${esc(st.draft)}" aria-label="Reply" placeholder="${n.kind === 'wa' ? 'WhatsApp message' : n.kind === 'email' ? 'Email reply' : 'Text message'}">
    <button class="send-btn" data-nact="send" title="Send" aria-label="Send">${ic('send', 14)}</button></div>`;
}

// Each rep gets the alerts for their own leads. An alert with no lead belongs to no rep, so only the owner's All reps shows it.
const canSeeNotif = n => canSee((notifLead(n) || { rep: '' }).rep);
const shownNotifs = () => notifications.filter(canSeeNotif);
const notifWho = n => { const lead = notifLead(n); return lead ? `${fullName(lead)} · ${lead.company}` : fmtPhone(n.number); };
function renderNotifs() {
  const list = shownNotifs();
  unreadCount = list.filter(n => !notifRead.has(n.id)).length;
  $('notifBadge').textContent = unreadCount || '';
  $('notifCount').textContent = unreadCount ? `${unreadCount} unread` : '';
  setLabel($('notifBtn'), unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications');
  renderTitle();
  $('notifList').innerHTML = list.map(n => {
    const lead = notifLead(n), st = notifState[n.id] || {};
    const head = `<span class="notif-who"><span>${esc(notifWho(n))}</span><span class="notif-time">${timeAgo(n.at)}</span></span><span class="notif-text">${esc(notifLine(n))}</span>`;
    return `
      <div class="notif-item${notifRead.has(n.id) ? '' : ' unread'}${newRow(n.id, n.at)}" data-nid="${n.id}">
        ${kindIcon(n.kind, 14)}
        <div class="notif-main">
          <div class="notif-row">${lead ? `<button class="notif-open" data-nact="lead">${head}</button>` : `<div class="notif-open">${head}</div>`}<div class="notif-acts">${notifActions(n)}</div></div>
          ${st.reply ? replyBox(n, st) : ''}
        </div>
      </div>`;
  }).join('') || '<div class="notif-empty"><b>You’re all caught up</b><span>New calls, messages and email opens show up here.</span></div>';
}

// The browser tab shows how many alerts are unread, or that a call is ringing.
const baseTitle = document.title;
function renderTitle() {
  document.title = phoneEngine.state.phase === 'incoming' ? `Incoming call · ${baseTitle}`
    : unreadCount ? `(${unreadCount}) ${baseTitle}` : baseTitle;
}

// New alerts come in here: campaign replies, opens, unsubscribes and STOPs today; missed calls, texts, WhatsApp and
// email once the phone and email services are connected. fields: { kind, leadId, ... } as in the sample alerts.
// Important alerts play their sound. No sound or banner during a call, and no banner for the lead already open on the Leads page.
function notify(fields) {
  const n = { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ...fields };
  notifications.unshift(n);
  renderNotifs();
  const openLead = page === 'leads' && !document.hidden && n.leadId === selectedId;
  if (!isImportant(n) || !canSeeNotif(n) || phoneEngine.state.phase !== 'idle') return;
  sounds.notice(n.kind);
  if (!openLead) banners.show(n);
}

// Opens the lead an alert is about (the list when it has no lead), and marks it read.
function openAlert(n) {
  markRead([n.id]);
  if (n.leadId) { setNotif(false); showPage('leads'); selectLead(n.leadId); } else setNotif(true);
  renderNotifs();
}


// ── NOTIFICATION BANNERS ──
// Top right under the topbar, newest on top, for 6 seconds each. The timers wait while the mouse or keyboard is on
// the banners. Three at most: older ones leave, and "+N more" opens the list. The banners never sit on the dialer.
const banners = (() => {
  const SHOW = 6000, MAX = 3, stack = $('nbStack');
  const live = [];
  let more = 0, held = false;

  function place() {
    stack.style.top = stack.style.right = '';
    if (!live.length || !dialerOpen) return;
    const d = dialerBox(), s = stack.getBoundingClientRect(), gap = 12;
    if (d.left >= s.right || d.right <= s.left || d.top >= s.bottom || d.bottom <= s.top) return;
    if (d.bottom + gap + s.height <= innerHeight) stack.style.top = d.bottom + gap + 'px';
    else stack.style.right = innerWidth - d.left + gap + 'px';
  }
  function renderMore() {
    let btn = stack.querySelector('.nb-more');
    if (!more || !live.length) { if (btn) btn.remove(); if (!live.length) more = 0; return; }
    if (!btn) { btn = document.createElement('button'); btn.type = 'button'; btn.className = 'nb-more'; stack.append(btn); }
    btn.textContent = `+${more} more`;
  }
  function remove(b) {
    clearTimeout(b.timer);
    live.splice(live.indexOf(b), 1);
    b.el.remove();
    if (!live.length) held = false;
    renderMore();
    place();
  }
  function run(b) { b.since = Date.now(); b.timer = setTimeout(() => remove(b), b.left); }
  function show(n) {
    if (live.length === MAX) { remove(live[live.length - 1]); more += 1; }
    const el = document.createElement('div');
    el.className = 'nb';
    el.dataset.kind = n.kind;
    el.innerHTML = `${kindIcon(n.kind, 15)}
      <button class="nb-main" type="button"><span class="nb-who"><span>${esc(notifWho(n))}</span><span class="nb-time">${timeAgo(n.at)}</span></span><span class="nb-text">${esc(notifLine(n))}</span></button>
      <button class="nb-x" type="button" title="Dismiss" aria-label="Dismiss">${ic('x', 12)}</button>`;
    const b = { n, el, left: SHOW, timer: 0, since: 0 };
    live.unshift(b);
    stack.prepend(el);
    if (!held) run(b);
    renderMore();
    place();
  }
  function clear() { [...live].forEach(remove); }
  function hold(on) {
    if (on === held) return;
    held = on;
    live.forEach(b => { if (on) { clearTimeout(b.timer); b.left -= Date.now() - b.since; } else run(b); });
  }

  stack.addEventListener('click', e => {
    if (e.target.closest('.nb-more')) { clear(); setNotif(true); return; }
    const b = live.find(x => x.el.contains(e.target));
    if (!b) return;
    if (e.target.closest('.nb-x')) { remove(b); return; }
    if (e.target.closest('.nb-main')) { remove(b); openAlert(b.n); }
  });
  stack.addEventListener('pointerenter', () => hold(true));
  stack.addEventListener('pointerleave', () => { if (!stack.contains(document.activeElement)) hold(false); });
  stack.addEventListener('focusin', () => hold(true));
  stack.addEventListener('focusout', e => { if (!stack.contains(e.relatedTarget) && !stack.matches(':hover')) hold(false); });
  addEventListener('resize', place);
  return { show, clear, place };
})();

function markRead(ids) {
  ids.forEach(id => notifRead.add(id));
  store.write('nv.notifRead', [...notifRead]);
}

function setNotif(on) {
  notifOpen = on;
  if (on) renderNotifs();
  $('notifMenu').classList.toggle('open', on);
  $('notifMenu').inert = !on;
  $('notifBtn').setAttribute('aria-expanded', on);
}

function focusReply(id) {
  const input = $('notifList').querySelector(`[data-nid="${id}"] [data-reply]`);
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function sendReply(n, st) {
  const text = (st.draft || '').trim();
  if (!text) { toast('Type a message first.'); return; }
  const sent = n.kind === 'email' ? mail.quickReply(n.ref, text) && 'Email sent' : sendMessage(n.kind === 'wa' ? 'wa' : 'text', n.number, text)?.phone;
  if (!sent) { toast(n.kind === 'email' ? 'Not sent — this email is no longer in the mailbox.' : `Not sent — ${phoneEngine.activePhone().name} is not connected.`); return; }
  Object.assign(st, { reply: false, draft: '' });
  toast(n.kind === 'email' ? sent : `Sent from ${sent}`);
}

// Opens the conversation in Panel 3 with the reply already typed in, ready to edit or send.
function openInThread(n, st) {
  const draft = (st.draft || '').trim() || notifSuggestion(n);
  setNotif(false);
  if (n.leadId) selectLead(n.leadId);
  if (n.kind === 'email') { if (page === 'leads') setTab('email'); mail.replyWith(n.ref, draft); return; }
  openThread(n.kind === 'wa' ? 'wa' : 'text', n.number);
  composerInput.value = draft;
  growInput();
  composerInput.focus();
}

$('notifBtn').addEventListener('click', () => setNotif(!notifOpen));
$('notifReadAll').addEventListener('click', () => { markRead(shownNotifs().map(n => n.id)); renderNotifs(); });
$('notifList').addEventListener('click', e => {
  const el = e.target.closest('[data-nact]');
  if (!el) return;
  const n = notifications.find(x => x.id === el.closest('[data-nid]').dataset.nid), st = (notifState[n.id] ||= {});
  markRead([n.id]);
  switch (el.dataset.nact) {
    case 'lead': openAlert(n); return;
    case 'call': if (n.leadId) selectLead(n.leadId); setNotif(false); if (n.number) callNumber(n.number); else runAct('call', actTarget('call', currentLead())); break;
    case 'reply':
      st.reply = !st.reply;
      if (st.reply && !st.draft) Object.assign(st, { draft: notifSuggestion(n), suggested: true });
      break;
    case 'thread': openInThread(n, st); return;
    case 'send': sendReply(n, st); break;
    case 'done': reminders.done(n.ref); return;
    case 'snooze': reminders.snoozeMenu(n.ref, el); return;
  }
  renderNotifs();
  if (st.reply) focusReply(n.id);
});
$('notifList').addEventListener('input', e => {
  if (!e.target.matches('[data-reply]')) return;
  notifState[e.target.closest('[data-nid]').dataset.nid].draft = e.target.value;
});
$('notifList').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[data-reply]')) e.target.parentElement.querySelector('[data-nact="send"]').click();
});


// ── LEAVING THE CRM ──
// Closing or reloading the window asks first while something would be lost: typing in the Add Lead window, an unsent
// text or WhatsApp message in Panel 3, a scan running, or a call. The browser shows its own box for this.
// Notes, email drafts and the campaign draft save by themselves, so they never need it.
addEventListener('beforeunload', e => {
  if (leadFormTyped() || composerInput.value.trim() || pendingFiles.length || scanner.running() || phoneEngine.state.phase !== 'idle') e.preventDefault();
});


// ── ESCAPE KEY ──
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  // The key must not also close the ask-first window it opens.
  if (modal.classList.contains('open')) { e.preventDefault(); leaveModal(); }
  else if (popAnchor) closePop();
  else if (scanner.escape()) return;
  else if (campaign.escape()) return;
  else if (mail.escape()) return;
  else if (notifOpen) setNotif(false);
  else if ($('dialMore')?.open) { $('dialMore').open = false; $('dialMore').querySelector('summary').focus(); }
  else if (keypadOpen) setKeypad(false);
  else if (entry !== null) { entry = null; renderDialer(); }
  else if (dialerOpen && phoneEngine.state.phase === 'idle' && dialInput.value) { dialInput.value = ''; renderDialer(); }
  else if (dialerOpen) setOpen(false);
});


// ── KEYBOARD SHORTCUTS ──
// ↑ ↓ move between leads · C call · T text · W WhatsApp · E email · / search. Off while typing or while the Add Lead window is open.
// On the Email page the mail shortcuts are used instead. The Scanner and Campaign pages have none.
// A key the dialer or a switch has already used is left alone.
addEventListener('keydown', e => {
  if (e.defaultPrevented) return;
  if (page === 'mail') { mail.keydown(e); return; }
  if (page !== 'leads') return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable="true"]') || modal.classList.contains('open')) return;
  const key = e.key.toLowerCase();
  if (key === 'arrowdown' || key === 'arrowup') {
    const list = visibleLeads(), i = list.findIndex(l => l.id === selectedId);
    const next = list[clamp(i + (key === 'arrowdown' ? 1 : -1), 0, list.length - 1)];
    if (!next) return;
    e.preventDefault();
    selectLead(next.id);
    $('leadList').querySelector(`[data-id="${next.id}"]`).scrollIntoView({ block: 'nearest' });
  } else if (key === '/') { e.preventDefault(); $('globalSearch').focus(); }
  else {
    const kind = { c: 'call', t: 'sms', w: 'wa', e: 'email' }[key];
    if (kind && currentLead()) { e.preventDefault(); quickAct(kind); }
  }
});
