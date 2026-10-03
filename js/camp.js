// ── CAMPAIGN ──
// Email and SMS campaigns, in five steps: Audience → Setup → Review → Live → Results.
// Everything here is worked out from the real lead list (leads): each lead's status, rep, and Touchpoints.
// A Touchpoint is one email address or one mobile number on a lead, with its own history (lead.touch, keyed by the
// address or the 10-digit number). The Dry Run only checks; it sends nothing.
//
// Counts are per recipient (one Touchpoint = one recipient). A lead with no email (or no mobile, for SMS) counts as one
// excluded recipient, "Invalid/Missing". A message is one send: one per recipient, or one per lead when email uses BCC.
//
// Where the rest comes from:
//   Email templates   mail.templates() (Email page › Settings › Templates)
//   Text templates    sample('smsTemplates')
//   Senders           sample('campaignSenders') — email accounts and iPhones, until the sending service is connected.
//                     An iPhone that has not checked in for 5 minutes counts as Offline; a sender at its daily limit as Limit reached.
//                     Every lead is sent from its own rep's senders, so the owner sending to a rep's leads uses that rep's.
// Reps: a new campaign starts with the signed-in rep checked, and only the leads of checked reps are in the audience.
// A rep can check only themselves; the owner can check any rep. Nobody checked means nobody gets the campaign.
// The draft (type, name, step, filters, per-type setup, schedule, note) is kept in this browser under nv.campaignDraft.
//
// Sending: Start builds the campaign record — every message with its sender, plus a snapshot of the audience, template,
// senders and protection — and hands it to the sending service. Records are kept under nv.campaigns (they are the History).
// The sending service is sample('campaignEngine'), a function that gets the api below and returns
// { start(), pause(), resume(), stop(), pauseSender(id), resumeSender(id) }. It owns the timing and reports every change
// through the api; this file owns the rules (who is still allowed a message, what a reply or STOP cancels, lead updates).
// Without a sending service, Start says so and sends nothing.
const campaign = (() => {
  const page = $('campPage'), menu = $('campMenu'), drawer = $('campDrawer'), dialog = $('campDialog');
  const more = $('campMore'), moreSummary = more.querySelector('summary');
  const MIN = 60000, DAY = 86400000, STALE = 5 * MIN;
  const STEPS = ['audience', 'setup', 'review', 'live', 'results'];
  const SECTIONS = { campAudience: ['audience'], campSetup: ['setup'], campReview: ['review'], campRun: ['live', 'results'] };
  const RUNNING = ['scheduled', 'running', 'paused'];
  const STATUSES = ['NEW', 'ATTEMPTED', 'ENGAGED', 'CONTRACT', 'IGNORE'];
  const STATUS_TONES = { NEW: 'open', ATTEMPTED: 'warn', ENGAGED: 'good', CONTRACT: 'good', IGNORE: 'done' };
  const STATES = {
    never: 'Never contacted', queued: 'Queued', attempted: 'Attempted', sent: 'Sent', delivered: 'Delivered', failed: 'Failed',
    replied: 'Replied', opened: 'Open detected', clicked: 'Click detected', unsubscribed: 'Unsubscribed', stop: 'STOP',
    invalid: 'Invalid', suppressed: 'Suppressed', dnc: 'Do not contact'
  };
  // Touchpoints in these states are never sent to.
  const BLOCKED = { unsubscribed: 'unsub', stop: 'stop', invalid: 'invalid', suppressed: 'suppressed', dnc: 'suppressed' };
  const REASONS = { ignore: 'Ignore', unsub: 'Unsubscribed', stop: 'STOP', suppressed: 'Suppressed', duplicate: 'Duplicates', invalid: 'Invalid/Missing', cooldown: 'Cooldown' };
  const TOUCH_TONES = { never: 'open', replied: 'good', failed: 'warn' };
  const TOUCH = { all: () => true, never: s => s === 'never', contacted: s => s !== 'never', failed: s => s === 'failed' };
  const FIELD = { email: 'Email', sms: 'Mobile' };
  const METHODS = { rep: 'Assigned rep', single: 'One sender' };
  // Sender states. idle, waiting and cooldown only happen while a campaign runs.
  const SENDER = {
    ready: ['Ready', 'good'], idle: ['Done', 'done'], waiting: ['Waiting', 'warn'], cooldown: ['Batch cooldown', 'warn'],
    paused: ['Paused', 'warn'], limit: ['Limit reached', 'warn'], offline: ['Offline', 'block'], error: ['Error', 'block']
  };
  const CANT_SEND = ['paused', 'limit', 'offline', 'error'];
  const RUN_STATUS = { scheduled: ['Scheduled', 'open'], running: ['Running', 'good'], paused: ['Paused', 'warn'], completed: ['Completed', 'good'], stopped: ['Stopped', 'block'] };
  const EVENTS = {
    sent: ['SENT', 'done'], delivered: ['DELIVERED', 'good'], failed: ['FAILED', 'block'], retry: ['RETRY', 'warn'], skipped: ['SKIPPED', 'off'],
    cancelled: ['CANCELLED', 'off'], reply: ['REPLY', 'good'], opened: ['OPEN DETECTED', 'open'], unsubscribed: ['UNSUBSCRIBED', 'block'],
    stop: ['STOP', 'block'], started: ['STARTED', 'open'], paused: ['PAUSED', 'warn'], resumed: ['RESUMED', 'open'], throttled: ['THROTTLED', 'warn'],
    stopped: ['STOPPED', 'block'], completed: ['COMPLETED', 'good']
  };
  const FEED = {
    all: ['All', () => true], sent: ['Sent', k => k === 'sent' || k === 'delivered'], failed: ['Failed', k => k === 'failed' || k === 'retry'],
    skipped: ['Skipped', k => k === 'skipped' || k === 'cancelled'], replies: ['Replies', k => k === 'reply'], unsub: ['Unsubscribed', k => k === 'unsubscribed' || k === 'stop']
  };
  const DELAYS = { fixed: 'Fixed delay', range: 'Delay range', batch: 'Batches' };
  const VARS = { first: l => l.first, last: l => l.last, company: l => l.company, rep: l => l.rep, email: l => (l.emails || [])[0] || '', phone: l => (l.phones.find(p => p.type === 'mobile') || l.phones[0] || {}).num || '' };

  // ── DRAFT ──
  const blankFilters = () => ({
    reps: allowedReps().includes(user.name) ? [user.name] : [], statuses: [], touch: 'all', search: '',
    states: [], industries: [], revMin: '', revMax: '', last: 'any', days: 30, hasEmail: false, hasMobile: false, fields: []
  });
  const blankProtection = type => ({
    delay: 'range', min: type === 'sms' ? 30 : 20, max: type === 'sms' ? 60 : 45, batchSize: 25, batchWait: 10,
    hourly: type === 'sms' ? 40 : 60, daily: '', campaignMax: '', windowOn: true, windowStart: '09:00', windowEnd: '19:00', cooldown: 3,
    retries: 1, stopOnReply: true, stopStatuses: ['ENGAGED', 'CONTRACT'], autoSlow: true, pauseAfter: 3, pauseRate: 10
  });
  // senders: [] means every ready sender. mode (Individual / BCC) is for email only.
  const blankChannel = type => ({ template: '', senders: [], method: 'rep', ...(type === 'email' ? { mode: 'individual' } : {}), protection: blankProtection(type) });
  // version 2: an empty rep list means no rep (before, it meant every rep).
  const blankDraft = () => ({
    version: 2, type: 'email', name: '', step: 'audience', record: '', filters: blankFilters(),
    channels: { email: blankChannel('email'), sms: blankChannel('sms') }, schedule: { when: 'now', at: '' }, notes: ''
  });
  // Reps this person may check: the owner any rep, everyone else only themselves.
  const allowedReps = () => isOwner ? [...new Set([...repNames(), ...leads.map(l => l.rep)].filter(Boolean))].sort() : [user.name];
  const allowed = reps => reps.filter(r => allowedReps().includes(r));
  // A channel saved by an earlier version: Round robin is gone (every lead goes out from its own rep's senders).
  function fitChannel(c) {
    const out = { ...c, method: METHODS[c.method] ? c.method : 'rep' };
    delete out.affinity;
    return out;
  }
  // A draft saved by an earlier version gets any settings it does not have yet, and starts with the signed-in rep checked.
  function loadDraft() {
    const s = store.read('nv.campaignDraft', {}), b = blankDraft(), sc = s.channels || {};
    const channels = Object.fromEntries(Object.entries(b.channels).map(([k, c]) => [k, fitChannel({ ...c, ...sc[k], protection: { ...c.protection, ...(sc[k] || {}).protection } })]));
    const filters = { ...b.filters, ...s.filters };
    filters.reps = s.version === 2 ? allowed(filters.reps) : b.filters.reps;
    return { ...b, ...s, version: 2, filters, channels, schedule: { ...b.schedule, ...s.schedule } };
  }
  const draft = loadDraft();
  const view = { screen: 'overview', list: 'selected', menu: '', menuButton: null, drawer: '', preview: null, dry: null, feed: 'all', feedQuery: '', frame: 0, tplOpen: false, tplId: '' };
  let ticker = 0;

  // ── HELPERS ──
  const count = n => n.toLocaleString('en-US');
  const plural = (n, one, many = one + 's') => `${count(n)} ${n === 1 ? one : many}`;
  const unique = list => [...new Set(list)];
  const amount = text => { const s = String(text).replace(/[$,\s]/g, ''); return s === '' || !Number.isFinite(+s) || +s < 0 ? null : +s; };
  const badAmount = text => String(text).trim() !== '' && amount(text) === null;
  const repName = rep => rep || 'Unassigned';
  const isMobile = p => p.type === 'mobile';
  const lastContact = lead => Math.max(0, ...Object.values(lead.touch).filter(t => t.state !== 'never').map(t => t.at));
  // Where the page is (step, record on screen) is not part of what a new campaign clears.
  const settingsOf = d => JSON.stringify({ ...d, step: '', record: '' });
  const isChanged = () => settingsOf(draft) !== settingsOf(blankDraft());
  const ch = () => draft.channels[draft.type];
  const prot = () => ch().protection;
  const tag = (tone, html, title = '') => `<span class="cp-tag" data-tone="${tone}"${title ? ` title="${esc(title)}"` : ''}>${html}</span>`;
  const hm = t => { const [h, m] = t.split(':').map(Number); return clockTime(Date.UTC(2000, 0, 1, h, m), 'UTC'); };
  function duration(secs) {
    const m = Math.round(secs / 60);
    return m < 1 ? 'under a minute' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  const pad = n => String(n).padStart(2, '0');
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`; };
  const shortClock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
  const dateTime = ts => showTime(ts, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const startText = d => showTime(d, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function countdown(at) {
    const s = Math.floor((at - Date.now()) / 1000);
    if (s <= 0) return 'The start time has passed';
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600);
    return `Starts in ${d ? d + 'd ' : ''}${pad(h)}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
  }
  // Keeps the keyboard where it was when a part of the page is drawn again.
  function keepFocus(draw) {
    const key = document.activeElement?.dataset?.key;
    draw();
    if (key) page.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }
  // Reads a drawer field. Returns undefined when the value is not allowed (the field is then marked invalid).
  function readField(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'time') return el.value || undefined;
    if (!el.dataset.num) return el.value;
    const [lo, hi] = el.dataset.num.split(',').map(Number), v = el.value.trim();
    if (v === '' && el.hasAttribute('data-blank')) return '';
    const n = Number(v);
    return v !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
  }

  // ── TEMPLATES ──
  const smsTemplates = store.read('nv.sms.templates', sample('smsTemplates', []).map(t => ({ ...t })));
  const saveSmsTemplates = () => store.write('nv.sms.templates', smsTemplates);
  const templates = () => draft.type === 'email'
    ? mail.templates().map(t => ({ id: t.id, name: t.name, subject: t.subject, body: t.html }))
    : smsTemplates;
  const template = () => templates().find(t => t.id === ch().template) || null;
  const VAR_CHIPS = ['first', 'last', 'company', 'rep', 'email', 'phone'];
  function saveEmailTemplates() { store.write('nv.mail.templates', mail.templates()); }
  function currentTpl() { return templates().find(t => t.id === view.tplId) || templates()[0] || null; }
  function setTplOpen(on) {
    view.tplOpen = on;
    if (on) {
      view.tplId = ch().template || (templates()[0] || {}).id || '';
      Object.entries(SECTIONS).forEach(([id]) => { $(id).hidden = true; });
      $('campTemplates').hidden = false;
      renderTemplates();
    } else {
      $('campTemplates').hidden = true;
      render();
    }
  }
  function upsertTemplate(fields) {
    if (draft.type === 'email') {
      const list = mail.templates();
      let tp = list.find(t => t.id === view.tplId);
      if (!tp) { tp = { id: 'tp' + Date.now().toString(36), name: 'New template', subject: '', html: '' }; list.push(tp); view.tplId = tp.id; }
      Object.assign(tp, fields.html !== undefined ? { name: fields.name, subject: fields.subject, html: fields.html } : fields);
      saveEmailTemplates();
    } else {
      let tp = smsTemplates.find(t => t.id === view.tplId);
      if (!tp) { tp = { id: 'sms-' + Date.now().toString(36), name: 'New template', body: '' }; smsTemplates.push(tp); view.tplId = tp.id; }
      Object.assign(tp, fields.body !== undefined ? fields : fields);
      saveSmsTemplates();
    }
    ch().template = view.tplId;
    save();
    renderTemplates();
  }
  function renderTemplates() {
    const list = templates(), isEmail = draft.type === 'email', cur = currentTpl();
    if (cur) view.tplId = cur.id;
    $('campTplList').innerHTML = `<div class="panel-head"><span class="panel-title">${isEmail ? 'Email' : 'SMS'} templates</span>
      <button class="btn" type="button" data-tpl="new">New</button></div>
      ${list.map(t => `<button class="cp-tpl-row${t.id === view.tplId ? ' on' : ''}" type="button" data-tpl-id="${esc(t.id)}">${esc(t.name)}</button>`).join('')
        || '<p class="cp-muted cp-pad">No templates yet.</p>'}`;
    $('campTplEdit').innerHTML = cur ? `<label class="cp-line">Name <input class="input" id="tplName" value="${esc(cur.name)}"></label>
      ${isEmail ? `<label class="cp-line">Subject <input class="input" id="tplSubject" value="${esc(cur.subject || '')}"></label>` : ''}
      <div class="cp-tpl-chips">${VAR_CHIPS.map(v => `<button class="btn" type="button" data-var="{${v}}">{${v}}</button>`).join('')}</div>
      <textarea class="input cp-tpl-body" id="tplBody" rows="12">${esc(isEmail ? (cur.html || cur.body || '') : (cur.body || ''))}</textarea>
      <div class="st-actions"><button class="btn primary" type="button" data-tpl="save">Save</button>
        <button class="btn" type="button" data-tpl="delete">Delete</button>
        <button class="btn" type="button" data-tpl="close">Back to campaign</button></div>`
      : `<p class="cp-muted cp-pad">Make a template, then insert {first} {last} {company} {rep} {email} {phone}.</p>
        <button class="btn primary" type="button" data-tpl="new">New template</button>
        <button class="btn" type="button" data-tpl="close">Back to campaign</button>`;
  }
  const varsIn = text => unique([...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]));
  const merge = (text, lead, html) => String(text).replace(/\{(\w+)\}/g, (m, k) => VARS[k] ? (html ? esc(VARS[k](lead) || '') : VARS[k](lead) || '') : m);

  // ── SENDERS ──
  const senders = () => sample('campaignSenders', { email: [], sms: [] })[draft.type].filter(s => allowedReps().includes(s.rep));
  function senderState(s) {
    if (s.state !== 'ready') return s.state;
    if (s.heartbeat && Date.now() - s.heartbeat > STALE) return 'offline';
    return s.sentToday >= s.limit ? 'limit' : 'ready';
  }
  const isReady = s => senderState(s) === 'ready';
  const senderName = s => s.number ? `${s.name} ${fmtPhone(s.number)}` : s.name;
  // The senders this campaign may use. One sender: the one picked. Otherwise the ones picked, or every ready sender.
  function chosen() {
    const c = ch(), all = senders();
    return c.method === 'single' ? all.filter(s => s.id === c.senders[0]) : c.senders.length ? all.filter(s => c.senders.includes(s.id)) : all.filter(isReady);
  }
  function senderProblem(s) {
    const st = senderState(s);
    return s.error || (st === 'offline' && s.heartbeat ? `No check-in since ${timeAgo(s.heartbeat)}` : st === 'limit' ? 'Daily limit reached' : '');
  }

  // ── PROTECTION ──
  function protectionIssues() {
    const p = prot(), floor = draft.type === 'sms' ? 20 : 10;
    return [p.min < floor && `less than ${floor} seconds between sends`, !p.cooldown && 'cooldown is off', !p.windowOn && 'send window is off',
      !p.stopOnReply && 'stop on reply is off', !p.autoSlow && 'automatic slowdown is off', !p.pauseAfter && 'senders never pause after failures'].filter(Boolean);
  }
  function protectionSummary(p = prot()) {
    const pace = p.delay === 'range' ? `${p.min}–${p.max} seconds apart` : p.delay === 'batch' ? `batches of ${p.batchSize}, ${p.batchWait} min between` : `${p.min} seconds apart`;
    return [pace, p.cooldown ? `${p.cooldown}-day cooldown` : '', p.windowOn ? `${hm(p.windowStart)}–${hm(p.windowEnd)} lead time` : ''].filter(Boolean).join(', ');
  }
  const protectionTag = () => protectionIssues().length ? tag('warn', '<b>Caution</b>') : tag('good', '<b>Normal</b>');

  // ── AUDIENCE ──
  function touchpoints(lead, type) {
    const list = type === 'email' ? lead.emails.map(e => ({ value: e.toLowerCase(), shown: e }))
      : lead.phones.filter(isMobile).map(p => ({ value: p.num, shown: fmtPhone(p.num) }));
    return list.map((t, i) => {
      const h = lead.touch[t.value];
      return { ...t, label: `${FIELD[type]} ${i + 1}`, state: h ? h.state : 'never', at: h ? h.at : 0 };
    });
  }

  // The leads this person could send to: those of the reps they may check.
  const reachable = () => leads.filter(l => allowedReps().includes(l.rep));
  const OPTIONS = {
    reps: allowedReps,
    statuses: () => STATUSES,
    states: () => unique(reachable().map(l => stateOf(l.address)).filter(Boolean)).sort(),
    industries: () => unique(reachable().map(l => l.industry).filter(Boolean)).sort(),
    fields: () => Array.from({ length: Math.max(0, ...reachable().map(l => touchpoints(l, draft.type).length)) }, (_, i) => `${FIELD[draft.type]} ${i + 1}`)
  };
  const optionName = (key, value) => key === 'reps' ? repName(value) : key === 'fields' && value.endsWith(' 1') ? value + ' (primary)' : value;

  function leadMatches(lead, f) {
    const q = f.search.trim().toLowerCase(), min = amount(f.revMin), max = amount(f.revMax);
    const last = lastContact(lead), cutoff = Date.now() - f.days * DAY;
    return f.reps.includes(lead.rep)
      && (!f.statuses.length || f.statuses.includes(lead.status))
      && (!q || lead.company.toLowerCase().includes(q) || fullName(lead).toLowerCase().includes(q))
      && (!f.states.length || f.states.includes(stateOf(lead.address)))
      && (!f.industries.length || f.industries.includes(lead.industry))
      && (min === null || lead.value >= min) && (max === null || lead.value <= max)
      && (f.last === 'any' || (f.last === 'never' ? !last : f.last === 'within' ? last >= cutoff : last < cutoff))
      && (!f.hasEmail || lead.emails.length > 0) && (!f.hasMobile || lead.phones.some(isMobile));
  }

  // Works out, lead by lead (highest revenue first), which Touchpoints are used and why any are left out.
  // A lead is selected when it passes the lead filters and has a Touchpoint that passes the Touchpoint filters.
  // Left out: Ignore leads, blocked Touchpoints, Touchpoints inside the cooldown, and addresses already used above (Duplicates).
  function audience() {
    const f = draft.filters, seen = new Set(), rows = [], reasons = {};
    const totals = { selected: 0, eligible: 0, excluded: 0 }, coolFrom = Date.now() - prot().cooldown * DAY;
    const picks = t => (!f.fields.length || f.fields.includes(t.label)) && TOUCH[f.touch](t.state);
    for (const lead of [...leads].sort(byRevenue)) {
      if (!leadMatches(lead, f)) continue;
      const tps = touchpoints(lead, draft.type).map(t => ({ ...t, picked: picks(t), reason: '' }));
      const used = tps.filter(t => t.picked);
      if (tps.length ? !used.length : f.touch !== 'all' || f.fields.length) continue;
      used.forEach(t => {
        t.reason = lead.status === 'IGNORE' ? 'ignore' : BLOCKED[t.state]
          || (t.state !== 'never' && t.at > coolFrom ? 'cooldown' : seen.has(t.value) ? 'duplicate' : '');
        if (!t.reason) seen.add(t.value);
      });
      const outcomes = tps.length ? used.map(t => t.reason) : [lead.status === 'IGNORE' ? 'ignore' : 'invalid'];
      const excluded = outcomes.filter(Boolean);
      excluded.forEach(r => { reasons[r] = (reasons[r] || 0) + 1; });
      totals.selected += outcomes.length;
      totals.excluded += excluded.length;
      totals.eligible += outcomes.length - excluded.length;
      rows.push({ lead, tps, eligible: outcomes.length - excluded.length, excluded: unique(excluded) });
    }
    return { rows, totals, reasons };
  }

  // ── THE PLAN: messages, who sends them, how long it takes ──
  function messages(aud) {
    const list = [], bcc = draft.type === 'email' && ch().mode === 'bcc';
    aud.rows.forEach(r => {
      const ok = r.tps.filter(t => t.picked && !t.reason);
      if (!ok.length) return;
      if (bcc) list.push({ lead: r.lead, to: ok[0], bcc: ok.slice(1) });
      else ok.forEach(t => list.push({ lead: r.lead, to: t, bcc: [] }));
    });
    const max = prot().campaignMax;
    return { list: max !== '' && list.length > max ? list.slice(0, max) : list, total: list.length };
  }

  // Only ready senders get messages, and a lead only from its own rep's senders. Assigned rep: that rep's senders
  // take turns. One sender: that sender only, so only its rep's leads get the campaign.
  function route(list) {
    const c = ch(), pool = chosen(), ready = pool.filter(isReady);
    const counts = new Map(ready.map(s => [s.id, 0])), unassigned = {}, turn = {}, byLead = new Map(), picks = [];
    list.forEach(m => {
      const rep = m.lead.rep, cands = ready.filter(s => s.rep === rep);
      if (!cands.length) {
        const why = !pool.length ? 'no sender is picked' : c.method === 'single' && pool[0].rep !== rep ? `${senderName(pool[0])} is not ${rep}’s`
          : c.method === 'single' ? `${senderName(pool[0])} is not ready` : `no ready sender for ${rep}`;
        unassigned[why] = (unassigned[why] || 0) + 1;
        picks.push({ sender: null, why });
        return;
      }
      const key = cands.map(s => s.id).join(), s = cands[(turn[key] = (turn[key] ?? -1) + 1) % cands.length];
      counts.set(s.id, counts.get(s.id) + 1);
      picks.push({ sender: s, why: '' });
      if (!byLead.has(m.lead.id)) byLead.set(m.lead.id, s);
    });
    return { pool, ready, counts, unassigned, byLead, picks };
  }

  // Senders work side by side, so the time is the busiest sender's time. Each sender waits the delay between sends
  // (at least 3600 ÷ its hourly limit), plus the pause between batches. Days: how many days the daily limits need.
  function estimate(r) {
    const p = prot(), gap = Math.max(p.delay === 'range' ? (p.min + p.max) / 2 : p.min, 3600 / p.hourly);
    let secs = 0, days = 0;
    r.ready.forEach(s => {
      const n = r.counts.get(s.id);
      if (!n) return;
      const daily = p.daily === '' ? s.limit : Math.min(s.limit, p.daily), today = Math.max(0, daily - s.sentToday);
      days = Math.max(days, n <= today ? 1 : 1 + Math.ceil((n - today) / daily));
      secs = Math.max(secs, n * gap + (p.delay === 'batch' ? Math.floor((n - 1) / p.batchSize) * p.batchWait * 60 : 0));
    });
    return { secs, days };
  }

  function startTime() {
    if (draft.schedule.when === 'now') return new Date();
    const t = fromInput(draft.schedule.at);
    return isNaN(t) ? null : new Date(t);
  }
  // The lead's own clock as 09:05 (their zone from the address, or Eastern when unknown), for the sending window.
  const localHM = (zone, d) => showTime(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, zone || ZONE);
  const inWindow = (t, a, b) => a <= b ? t >= a && t < b : t >= a || t < b;

  function plan() {
    const aud = audience(), msgs = messages(aud), r = route(msgs.list), p = prot(), start = startTime();
    const outside = p.windowOn && start
      ? unique(msgs.list.filter(m => !inWindow(localHM(zoneOf(m.lead.address), start), p.windowStart, p.windowEnd)).map(m => m.lead.id)).length : 0;
    return { aud, msgs, r, est: estimate(r), outside, start };
  }

  function estimateText(x) {
    if (!x.msgs.list.length) return 'Nothing to send';
    if (!x.r.ready.length) return 'Estimate unavailable';
    return `~${duration(x.est.secs)}${x.est.days > 1 ? `, over ${x.est.days} days` : ''}`;
  }

  // ── STEP 1: AUDIENCE ──
  // Reps: none checked means nobody. Status: none checked means every status.
  function menuLabel(key) {
    const list = draft.filters[key];
    return !list.length ? (key === 'reps' ? 'None' : 'All') : key === 'reps' && list.length === OPTIONS.reps().length && list.length > 1 ? 'All'
      : list.length === 1 ? optionName(key, list[0]) : `${list.length} selected`;
  }
  const chevron = ic('chevron', 10);
  function advancedCount() {
    const f = draft.filters;
    return [f.states.length, f.industries.length, amount(f.revMin) !== null, amount(f.revMax) !== null, f.last !== 'any', f.hasEmail, f.hasMobile, f.fields.length].filter(Boolean).length;
  }
  function renderLabels() {
    const adv = advancedCount();
    $('campRep').innerHTML = `Rep <b>${esc(menuLabel('reps'))}</b>${chevron}`;
    $('campStatus').innerHTML = `Status <b>${esc(menuLabel('statuses'))}</b>${chevron}`;
    $('campAdvanced').innerHTML = `Advanced filters${adv ? ` <b>${adv}</b>` : ''}`;
  }

  function touchTag(t) {
    const tone = !t.picked ? 'off' : t.reason ? 'block' : TOUCH_TONES[t.state] || 'done';
    const word = t.reason === 'duplicate' ? 'Duplicate' : t.reason === 'cooldown' ? 'Cooldown' : STATES[t.state];
    const title = `${t.shown} — ${STATES[t.state]}${t.at ? ', ' + timeAgo(t.at) : ''}${!t.picked ? ' · left out by your filters' : t.reason ? ' · excluded: ' + REASONS[t.reason] : ''}`;
    return tag(tone, `${t.label} <b>${esc(word)}</b>`, title);
  }

  function row(r) {
    const l = r.lead;
    const tps = r.tps.length ? r.tps.map(touchTag).join('') : tag('block', `No ${draft.type === 'email' ? 'email' : 'mobile'} on file`);
    const result = r.eligible ? plural(r.eligible, 'recipient') : `Excluded: ${r.excluded.map(x => REASONS[x]).join(', ')}`;
    return `<tr>
      <td><span class="cp-lead-name">${esc(l.company)}</span><button class="open-record" type="button" data-lead="${l.id}" title="Open record" aria-label="Open ${esc(l.company)} in Leads">${ic('open', 12)}</button><span class="cp-sub">${esc(fullName(l))}</span></td>
      <td>${esc(repName(l.rep))}</td>
      <td>${tag(STATUS_TONES[l.status], `<b>${l.status}</b>`)}</td>
      <td class="cp-num">${money(l.value)}</td>
      <td><div class="cp-tags">${tps}</div></td>
      <td class="cp-result${r.eligible ? '' : ' cp-out'}">${esc(result)}</td>
    </tr>`;
  }

  function renderAudience() {
    const { rows, totals, reasons } = audience();
    const shown = rows.filter(r => view.list === 'selected' || (view.list === 'eligible' ? r.eligible : r.excluded.length));
    const counts = [['selected', 'Selected'], ['eligible', 'Eligible'], ['excluded', 'Excluded']];
    renderLabels();
    $('campCounts').innerHTML = counts.map(([key, name]) =>
      `<button type="button" data-view="${key}" data-key="view-${key}" aria-pressed="${view.list === key}">${name} <b>${count(totals[key])}</b></button>`).join('')
      + `<span class="cp-leads">${plural(rows.length, 'lead')}</span>`;
    $('campReasons').innerHTML = view.list === 'excluded'
      ? Object.entries(REASONS).filter(([k]) => reasons[k]).map(([k, name]) => `<span>${name} <b>${count(reasons[k])}</b></span>`).join('') : '';
    $('campTable').innerHTML = shown.length ? `<thead><tr><th scope="col">Company</th><th scope="col">Rep</th><th scope="col">Status</th>
      <th scope="col" class="cp-num">Revenue</th><th scope="col">Touchpoints</th><th scope="col">Result</th></tr></thead>
      <tbody>${shown.map(row).join('')}</tbody>` : '';
    const empty = $('campEmpty');
    empty.hidden = shown.length > 0;
    empty.innerHTML = !reachable().length ? 'No leads yet. Leads added on the Leads page show here.'
      : !draft.filters.reps.length ? 'Pick at least one rep.'
      : !rows.length ? 'No leads match these filters. <button class="link-btn" type="button" data-clear="all">Clear filters</button>'
      : view.list === 'eligible' ? 'No one is eligible with these filters.' : 'Nothing is excluded.';
  }

  // ── STEP 2: SETUP ──
  const setupRow = (label, html) => `<div class="cp-row"><span class="cp-label">${label}</span><div class="cp-val">${html}</div></div>`;
  const seg = (group, value, options, label) => `<div class="seg" role="radiogroup" aria-label="${label}">${options.map(([v, t]) =>
    `<button type="button" role="radio" data-${group}="${v}" data-key="${group}-${v}" aria-checked="${v === value}" tabindex="${v === value ? 0 : -1}">${t}</button>`).join('')}</div>`;
  const drawerButton = (kind, text) => `<button class="btn" type="button" data-drawer-open="${kind}" data-key="open-${kind}" aria-expanded="${view.drawer === kind}" aria-controls="campDrawer">${text}</button>`;

  function senderSummary() {
    const c = ch(), pool = chosen(), ready = pool.filter(isReady).length;
    if (c.method === 'single') return pool.length ? `${esc(senderName(pool[0]))} ${tag(SENDER[senderState(pool[0])][1], `<b>${SENDER[senderState(pool[0])][0]}</b>`)}` : '<span class="cp-bad">Pick the sender</span>';
    if (!senders().length) return '<span class="cp-bad">No senders are connected</span>';
    return c.senders.length ? `${plural(pool.length, 'sender')} picked, ${count(ready)} ready` : `All ready senders (${count(ready)})`;
  }

  function scheduleValue() {
    const s = draft.schedule, start = startTime(), min = inputValue(Date.now());
    if (s.when === 'now') return seg('when', 'now', [['now', 'Send now'], ['later', 'Schedule']], 'When to send');
    return seg('when', 'later', [['now', 'Send now'], ['later', 'Schedule']], 'When to send')
      + `<input class="input" type="datetime-local" data-s="at" data-key="at" min="${min}" value="${esc(s.at)}" aria-label="Start date and time" aria-invalid="${!start || start < Date.now()}">`
      + (start ? `<span class="cp-muted">${esc(startText(start))}</span><span class="cp-count" data-countdown="${+start}">${countdown(+start)}</span>` : '<span class="cp-bad">Pick a date and time</span>');
  }

  function renderSetup() {
    const c = ch(), tpls = templates(), tpl = template(), isEmail = draft.type === 'email';
    $('campSetup').innerHTML = [
      setupRow('Template', `<select class="input cp-w-l" data-s="template" data-key="template" aria-label="Template">
          <option value="">${tpls.length ? 'Choose a template' : 'No templates yet'}</option>
          ${tpls.map(t => `<option value="${esc(t.id)}"${t.id === c.template ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        ${tpl && isEmail ? `<span class="cp-muted cp-clip">Subject: ${esc(tpl.subject)}</span>` : ''}
        ${tpl ? '<button class="btn" type="button" data-act="preview" data-key="preview">Preview</button>' : ''}
        <button class="link-btn" type="button" data-act="templates" data-key="templates">Manage templates</button>`),
      setupRow('Senders', `<select class="input" data-s="method" data-key="method" aria-label="How senders are chosen">
          ${Object.entries(METHODS).map(([v, t]) => `<option value="${v}"${v === c.method ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <span>${senderSummary()}</span>${drawerButton('senders', isEmail ? 'Email accounts' : 'iPhones')}`),
      isEmail ? setupRow('Send mode', seg('mode', c.mode, [['individual', 'Individual'], ['bcc', 'BCC']], 'Send mode')
        + (c.mode === 'bcc' ? '<span class="cp-warn">BCC reduces recipient-level tracking accuracy.</span>' : '<span class="cp-muted">One email to each address, tracked one by one.</span>')) : '',
      setupRow('Schedule', scheduleValue()),
      setupRow('Protection', `${protectionTag()}<span class="cp-muted cp-clip">${esc(protectionSummary())}</span>${drawerButton('protection', 'Protection')}`),
      setupRow('Note', `<input class="input cp-grow" type="text" data-s="notes" data-key="notes" maxlength="200" value="${esc(draft.notes)}" placeholder="Internal note, only your team sees it" aria-label="Internal note">`)
    ].join('');
  }

  // ── STEP 3: REVIEW + DRY RUN ──
  // The dry run is out of date when any setting it checked has changed since.
  const signature = () => JSON.stringify([draft.type, draft.filters, ch(), draft.schedule, leads.length]);

  function scheduleText(x) {
    if (draft.schedule.when === 'now') return 'Send now';
    if (!x.start) return '<span class="cp-bad">No start time</span>';
    return `${esc(startText(x.start))}
      <span class="cp-count" data-countdown="${+x.start}">${countdown(+x.start)}</span>`;
  }

  function renderReview() {
    const x = plan(), tpl = template(), c = ch(), isEmail = draft.type === 'email', t = x.aud.totals;
    const capped = x.msgs.total > x.msgs.list.length ? ` of ${count(x.msgs.total)} (campaign limit)` : '';
    const items = [
      ['Campaign', esc(draft.name.trim()) || '<span class="cp-muted">No name yet</span>'],
      ['Type', isEmail ? 'Email' : 'SMS'],
      ['Template', tpl ? esc(tpl.name) + (isEmail ? `<span class="cp-sub">${esc(tpl.subject)}</span>` : '') : '<span class="cp-bad">None picked</span>'],
      ['Selected', draft.filters.reps.length ? count(t.selected) : '<span class="cp-bad">Pick at least one rep</span>'], ['Eligible', count(t.eligible)], ['Excluded', count(t.excluded)],
      ['Messages', count(x.msgs.list.length) + capped + (isEmail ? `<span class="cp-sub">${c.mode === 'bcc' ? 'BCC: one email per lead' : 'Individual: one email per address'}</span>` : '')],
      ['Senders', `${count(x.r.ready.length)} ready of ${count(x.r.pool.length)}<span class="cp-sub">${METHODS[c.method]}</span>`],
      ['Schedule', scheduleText(x)],
      ['Protection', protectionTag()],
      ['Estimated', esc(estimateText(x))],
      ['Note', esc(draft.notes) || '<span class="cp-muted">None</span>']
    ];
    $('campReview').innerHTML = `<section class="cp-card" aria-label="Summary"><dl class="cp-sum">${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></section>
      <section class="cp-card cp-dry" aria-labelledby="campDryTitle">
        <div class="panel-head"><h2 class="panel-title" id="campDryTitle">Dry run</h2><span class="cp-muted">Checks everything. Sends nothing.</span>
          <div class="panel-tools"><button class="btn primary" type="button" data-act="dry" data-key="dry">${view.dry ? 'Run again' : 'Run dry run'}</button></div></div>
        ${dryReport()}
      </section>`;
  }

  function templateChecks(tpl, list) {
    if (!tpl) return [['fail', templates().length ? 'Pick a template.' : `There are no ${draft.type === 'email' ? 'email' : 'text'} templates yet.`]];
    const out = [], used = varsIn(`${tpl.subject || ''} ${tpl.body}`);
    if (draft.type === 'email' && !tpl.subject.trim()) out.push(['fail', 'The template has no subject.']);
    if (!tpl.body.replace(/<[^>]*>/g, '').trim()) out.push(['fail', 'The template is empty.']);
    used.filter(v => !VARS[v]).forEach(v => out.push(['fail', `{${v}} is not a field. Use {first}, {last}, {company}, {rep}, {email} or {phone}.`]));
    used.filter(v => VARS[v]).forEach(v => {
      const n = unique(list.filter(m => !VARS[v](m.lead)).map(m => m.lead.id)).length;
      if (n) out.push(['warn', `{${v}} is empty for ${plural(n, 'lead')}. They would see a blank there.`]);
    });
    if (draft.type === 'sms') {
      const long = unique(list.filter(m => merge(tpl.body, m.lead, false).length > 160).map(m => m.lead.id)).length;
      if (long) out.push(['warn', `The text is over 160 characters for ${plural(long, 'lead')}. It sends in 2 parts.`]);
    }
    return out.length ? out : [['ok', `Template “${tpl.name}” is ready.`]];
  }

  function dryRun() {
    const x = plan(), { totals, reasons } = x.aud, checks = [], issues = protectionIssues();
    if (!draft.filters.reps.length) checks.push(['fail', 'Pick at least one rep.']);
    else if (!totals.eligible) checks.push(['fail', 'No one is eligible. Change the audience filters.']);
    else checks.push(['ok', `${plural(totals.eligible, 'eligible recipient')}, ${plural(x.msgs.list.length, 'message')} to send.`]);
    checks.push(...templateChecks(template(), x.msgs.list));
    if (!x.r.ready.length) checks.push(['fail', 'No senders are ready.']);
    else checks.push(['ok', `Split: ${x.r.ready.filter(s => x.r.counts.get(s.id)).map(s => `${senderName(s)} ${count(x.r.counts.get(s.id))}`).join(', ') || 'none yet'}.`]);
    x.r.pool.filter(s => !isReady(s)).forEach(s => checks.push(['warn', `${senderName(s)} is ${SENDER[senderState(s)][0].toLowerCase()} and gets no messages.`]));
    Object.entries(x.r.unassigned).forEach(([why, n]) => checks.push(['warn', `${plural(n, 'message')} ${n === 1 ? 'has' : 'have'} no sender: ${why}.`]));
    if (draft.type === 'email' && ch().mode === 'bcc') checks.push(['warn', 'BCC reduces recipient-level tracking accuracy.']);
    if (x.msgs.total > x.msgs.list.length) checks.push(['warn', `Campaign limit: ${count(x.msgs.list.length)} of ${count(x.msgs.total)} messages will send.`]);
    if (x.est.days > 1) checks.push(['warn', `Needs ${x.est.days} days to finish at the daily limits.`]);
    if (!x.start) checks.push(['fail', 'Pick a start date and time.']);
    else if (draft.schedule.when === 'later' && x.start < Date.now()) checks.push(['fail', 'The start time has passed. Pick a future time.']);
    else checks.push(['ok', draft.schedule.when === 'now' ? 'Starts as soon as you start it.' : `Starts ${startText(x.start)}.`]);
    if (x.outside) checks.push(['warn', `${plural(x.outside, 'lead')} ${x.outside === 1 ? 'is' : 'are'} outside the send window at the start time. They wait until it opens.`]);
    checks.push(issues.length ? ['warn', `Protection: ${issues.join(', ')}.`] : ['ok', `Protection is normal (${protectionSummary()}).`]);
    const counts = [['Selected', totals.selected], ['Eligible', totals.eligible], ...Object.entries(REASONS).filter(([k]) => reasons[k]).map(([k, n]) => [n, reasons[k]]), ['Messages', x.msgs.list.length]];
    view.dry = { at: Date.now(), type: draft.type, sig: signature(), counts, checks, fails: checks.filter(c => c[0] === 'fail').length, warns: checks.filter(c => c[0] === 'warn').length };
  }

  function dryReport() {
    const d = view.dry;
    if (!d) return '<p class="cp-note">Run a dry run to check the audience, template, senders, schedule and protection before starting.</p>';
    const result = d.fails ? tag('block', `<b>${plural(d.fails, 'problem')}</b>`) : d.warns ? tag('warn', `<b>${plural(d.warns, 'warning')}</b>`) : tag('good', '<b>Passed</b>');
    const icons = { ok: 'done', warn: 'warning', fail: 'close' };
    return `<div class="cp-dry-head">${result}<span>Checked at ${clockTime(d.at)}. Nothing was sent.</span>
        ${d.sig !== signature() ? '<span class="cp-warn">Settings changed after this run. Run it again.</span>' : ''}</div>
      <div class="cp-reasons cp-dry-counts">${d.counts.map(([k, n]) => `<span>${k} <b>${count(n)}</b></span>`).join('')}</div>
      <ul class="cp-checks">${d.checks.map(([lvl, text]) => `<li data-level="${lvl}">${mi(icons[lvl], 16)}<span>${esc(text)}</span></li>`).join('')}</ul>`;
  }

  // ── PREVIEW ──
  function renderPreview() {
    const tpl = template(), x = plan(), isEmail = draft.type === 'email';
    const ids = unique(x.msgs.list.map(m => m.lead.id));
    if (!ids.includes(view.preview)) view.preview = ids[0] ?? null;
    const lead = leads.find(l => l.id === view.preview), mine = x.msgs.list.filter(m => m.lead.id === view.preview);
    const from = lead && x.r.byLead.get(lead.id);
    const fill = (text, html) => lead ? merge(text, lead, html) : html ? esc(text) : text;
    // Individual sends go one by one, so other addresses on the lead are listed apart from To.
    const meta = lead ? [['From', from ? esc(senderName(from)) : '<span class="cp-bad">No ready sender</span>'], ['To', esc(mine[0].to.shown)],
      ...(mine[0].bcc.length ? [['BCC', esc(mine[0].bcc.map(t => t.shown).join(', '))]] : []),
      ...(mine.length > 1 ? [['Also', `${esc(mine.slice(1).map(m => m.to.shown).join(', '))} <span class="cp-muted">(each gets its own ${isEmail ? 'email' : 'text'})</span>`]] : [])] : [];
    if (isEmail) meta.push(['Subject', esc(fill(tpl.subject, false))]);
    const used = varsIn(`${tpl.subject || ''} ${tpl.body}`);
    dialog.innerHTML = `<h2 class="modal-head" id="campDialogTitle">Preview: ${esc(tpl.name)}</h2>
      <div class="cp-preview">
        ${ids.length ? `<label class="cp-line">Lead <select class="input cp-w-l" data-preview data-key="preview-lead">${ids.map(id => {
          const l = leads.find(y => y.id === id);
          return `<option value="${id}"${id === view.preview ? ' selected' : ''}>${esc(l.company)} — ${esc(fullName(l))}</option>`;
        }).join('')}</select></label>` : '<p class="cp-warn">No one is eligible, so the fields are shown as they are written.</p>'}
        ${meta.length ? `<dl class="cp-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
        <div class="cp-body${isEmail ? '' : ' cp-text'}">${isEmail ? mail.safeHtml(fill(tpl.body, true)) : esc(fill(tpl.body, false))}</div>
        ${used.length ? `<div class="cp-tags">${used.map(v => !VARS[v] ? tag('block', `{${v}} <b>not a field</b>`)
          : lead ? (VARS[v](lead) ? tag('done', `{${v}} <b>${esc(VARS[v](lead))}</b>`) : tag('block', `{${v}} <b>empty</b>`)) : tag('done', `{${v}}`)).join('')}</div>` : ''}
      </div>
      <div class="modal-foot"><button class="btn primary" type="button" data-dialog="close">Close</button></div>`;
  }

  // ── CAMPAIGNS + THE SENDING SERVICE ──
  const records = store.read('nv.campaigns', []);
  // Every place that changes a campaign's saved record goes through here.
  function saveRecords() {
    return store.write('nv.campaigns', records);
  }
  const activeRecord = () => records.find(r => RUNNING.includes(r.status)) || null;

  // ── ONE-TAB LOCK ──
  // If this CRM is open in more than one tab, only one tab may actually run the sending engine.
  // Every other tab watches the same campaign read-only, so nothing gets sent twice.
  const TAB_ID = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const LOCK_KEY = 'nv.campaignLock', LOCK_STALE_MS = 5000;
  const readLock = () => store.read(LOCK_KEY, null);
  const haveLock = () => readLock()?.tabId === TAB_ID;
  // This tab may act on the active campaign if nothing is active, or if this tab holds the lock.
  const mine = () => !activeRecord() || haveLock();
  function claimLock() { store.write(LOCK_KEY, { tabId: TAB_ID, at: Date.now() }); }
  // Claims the lock only if it is free, stale (the owning tab likely closed), or already this tab's.
  function tryClaimLock() {
    const l = readLock();
    if (l && l.tabId !== TAB_ID && Date.now() - l.at < LOCK_STALE_MS) return false;
    claimLock();
    return true;
  }
  function releaseLock() { if (haveLock()) store.write(LOCK_KEY, null); }
  let heartbeat = 0;
  function startHeartbeat() { if (!heartbeat) heartbeat = setInterval(() => { if (haveLock()) claimLock(); }, 2000); }
  function stopHeartbeat() { clearInterval(heartbeat); heartbeat = 0; }
  // Retries every couple of seconds until this tab can take over an active campaign no one else is driving.
  let lockRetry = 0;
  function ensureEngineRunning() {
    if (!engine || !activeRecord() || haveLock()) { clearInterval(lockRetry); lockRetry = 0; return; }
    if (tryClaimLock()) { startHeartbeat(); engine.start(); clearInterval(lockRetry); lockRetry = 0; render(); }
    else if (!lockRetry) lockRetry = setInterval(ensureEngineRunning, 2000);
  }
  // Another tab changed the saved campaigns (or the lock). Pick up its latest state; never overwrite it.
  let syncQueued = false;
  window.addEventListener('storage', e => {
    if (e.key === 'nv.campaigns') {
      try { const fresh = JSON.parse(e.newValue) || []; records.length = 0; records.push(...fresh); } catch { return; }
    } else if (e.key !== LOCK_KEY) return;
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; ensureEngineRunning(); if (!page.hidden) render(); });
  });
  window.addEventListener('beforeunload', releaseLock);

  const recordOf = id => records.find(r => r.id === id) || null;
  // The owner and the rep who started a campaign see all of it. Any other rep sees only the part sent to their own leads,
  // from their own senders. A campaign saved by an older version has no starter (by), so reps see only their part.
  const fullView = r => isOwner || r.by === user.name;
  const viewOf = r => !r || fullView(r) ? r : {
    ...r,
    messages: r.messages.filter(m => m.rep === user.name),
    events: r.events.filter(e => e.leadId ? e.rep === user.name : !e.sender),
    snapshot: { ...r.snapshot, totals: null, senders: r.snapshot.senders.filter(x => x.rep === user.name), leadIds: r.snapshot.leadIds.filter(id => leadOf(id)?.rep === user.name) }
  };
  const visibleRecords = () => records.filter(r => fullView(r) || r.messages.some(m => m.rep === user.name));
  const shownRecord = () => draft.step === 'live' ? activeRecord() : recordOf(draft.record);
  const leadOf = id => leads.find(l => l.id === id);
  const senderById = (r, id) => r.snapshot.senders.find(s => s.id === id) || { name: '—', rep: '' };
  const protOf = r => r.snapshot.channel.protection;
  function findMessage(id) {
    const r = records.find(x => id.startsWith(x.id + ':'));
    return r ? [r, r.messages.find(m => m.id === id)] : [null, null];
  }
  // Live and Results redraw at most once a frame, and only while they are on screen.
  function queueRender() {
    if (view.frame || page.hidden || (draft.step !== 'live' && draft.step !== 'results')) return;
    view.frame = requestAnimationFrame(() => { view.frame = 0; renderStep(); });
  }
  function addEvent(r, kind, { m = null, sender = null, text = '' } = {}) {
    const s = sender || (m && senderById(r, m.senderId));
    r.events.push({ at: Date.now(), kind, text, leadId: m ? m.leadId : null, company: m ? m.company : '', rep: m ? m.rep : '',
      recipient: m ? `${m.to.label} ${m.to.shown}` : '', sender: s ? s.name : '', template: m ? r.snapshot.template.name : '' });
  }
  // Lead updates go through leads.js, so they show on the Leads page and last after a reload.
  function touchLead(m, value, state) {
    const lead = leadOf(m.leadId);
    if (lead) updateLead(lead.id, { touch: { ...lead.touch, [value]: { state, at: Date.now() } } });
  }
  const noteOn = (r, m, text) => logActivity(m.leadId, r.type === 'email' ? 'email' : 'sms', `Campaign “${r.name}”: ${text}`);
  // A real send attempt (sent or failed) moves a NEW lead to ATTEMPTED. A later status is never changed.
  function attempted(r, m) {
    const lead = leadOf(m.leadId);
    if (!lead || lead.status !== 'NEW') return;
    updateLead(lead.id, { status: 'ATTEMPTED' });
    noteOn(r, m, 'status NEW → ATTEMPTED');
  }
  function settle(r, m, state, reason) {
    Object.assign(m, { state, reason, at: Date.now() });
    addEvent(r, state, { m, text: reason });
  }
  // Takes waiting messages out of the queue. Stopping the campaign cancels them; the campaign's rules skip them.
  const dropQueued = (r, test, state, reason) => r.messages.filter(m => m.state === 'queued' && test(m)).forEach(m => settle(r, m, state, reason));

  // What the sending service may call.
  const api = {
    record: activeRecord,
    remaining: () => (activeRecord()?.messages || []).filter(m => m.state === 'queued').length,
    // The next message this sender may send. A message that is no longer allowed is skipped here, right before sending.
    nextFor(senderId) {
      const r = activeRecord(), p = protOf(r);
      for (const m of r.messages) {
        if (m.senderId !== senderId || m.state !== 'queued') continue;
        const lead = leadOf(m.leadId), h = lead && lead.touch[m.to.value];
        const why = !lead ? 'lead removed' : lead.status === 'IGNORE' ? 'lead is Ignore'
          : lead.status !== m.status && p.stopStatuses.includes(lead.status) ? `lead moved to ${lead.status}`
          : h && BLOCKED[h.state] ? STATES[h.state].toLowerCase() : '';
        if (!why) return m;
        settle(r, m, 'skipped', why);
        saveRecords();
        queueRender();
      }
      return null;
    },
    // Is it inside the send window right now, in the lead's local time?
    inWindow(m) {
      const p = protOf(activeRecord()), lead = leadOf(m.leadId);
      return inWindow(localHM(lead ? zoneOf(lead.address) : '', new Date()), p.windowStart, p.windowEnd);
    },
    setStatus(status, reason = '') {
      const r = activeRecord();
      if (!r || r.status === status) return;
      const now = Date.now(), was = r.status, ends = status === 'stopped' || status === 'completed';
      if (was === 'paused') { r.pausedTotal += now - r.pausedAt; r.pausedAt = 0; }
      if (status === 'running') { if (was === 'scheduled') r.startedAt = now; addEvent(r, was === 'paused' ? 'resumed' : 'started'); }
      if (status === 'paused') { r.pausedAt = now; addEvent(r, 'paused', { text: reason }); }
      if (status === 'stopped') dropQueued(r, () => true, 'cancelled', 'campaign stopped');
      if (ends) { r.endedAt = now; addEvent(r, status); }
      r.status = status;
      saveRecords();
      if (ends) { releaseLock(); stopHeartbeat(); }
      if (ends && draft.step === 'live') {
        Object.assign(draft, { step: 'results', record: r.id });
        save();
        if (!page.hidden) render();
      } else if (ends && !page.hidden) renderTop();
      else queueRender();
    },
    // state: sent · failed · delivered, or queued again for a retry after a failure.
    message(id, { state, reason = '' }) {
      const [r, m] = findMessage(id);
      if (!m) return;
      const word = r.type === 'email' ? 'Email' : 'Text', from = senderById(r, m.senderId).name;
      if (state === 'queued' && m.state === 'queued') {
        m.attempts += 1;
        addEvent(r, 'retry', { m, text: reason });
      } else if (m.state === 'queued' && (state === 'sent' || state === 'failed')) {
        settle(r, m, state, reason);
        [m.to, ...m.bcc].forEach(t => touchLead(m, t.value, state));
        noteOn(r, m, state === 'sent' ? `${word.toLowerCase()} sent to ${m.to.shown} from ${from} (${r.snapshot.template.name})` : `${word.toLowerCase()} to ${m.to.shown} failed: ${reason}`);
        attempted(r, m);
      } else if (state === 'delivered' && m.state === 'sent') {
        m.state = 'delivered';
        addEvent(r, 'delivered', { m });
        touchLead(m, m.to.value, 'delivered');
        noteOn(r, m, `${word.toLowerCase()} delivered to ${m.to.shown}`);
      } else return;
      saveRecords();
      queueRender();
    },
    // kind: opened · reply · unsubscribed · stop, for a message that went out.
    response(id, kind) {
      const [r, m] = findMessage(id);
      if (!m || (m.state !== 'sent' && m.state !== 'delivered') || m[kind]) return;
      m[kind] = true;
      const value = m.to.value, shown = m.to.shown, h = leadOf(m.leadId)?.touch[value];
      addEvent(r, kind, { m });
      if (kind === 'opened') {
        if (h && (h.state === 'sent' || h.state === 'delivered')) touchLead(m, value, 'opened');
        noteOn(r, m, `open detected on ${shown}`);
      } else if (kind === 'reply') {
        touchLead(m, value, 'replied');
        noteOn(r, m, `${shown} replied`);
        if (protOf(r).stopOnReply) dropQueued(r, x => x.leadId === m.leadId, 'skipped', 'lead replied');
      } else {
        touchLead(m, value, kind === 'stop' ? 'stop' : 'unsubscribed');
        noteOn(r, m, kind === 'stop' ? `STOP from ${shown}` : `${shown} unsubscribed`);
        dropQueued(r, x => x.to.value === value, 'skipped', kind === 'stop' ? 'STOP' : 'unsubscribed');
      }
      notify({ kind: 'campaign', event: kind, leadId: m.leadId, name: r.name, via: r.type === 'email' ? 'email' : 'text' });
      saveRecords();
      queueRender();
    },
    // changes: { state, nextAt, note, sent, fails }
    sender(id, changes) {
      const r = activeRecord();
      if (!r) return;
      r.senders[id] = { ...r.senders[id], ...changes };
      saveRecords();
      queueRender();
    },
    // Protection actions: kind is paused or throttled.
    event(kind, senderId, text) {
      const r = activeRecord();
      if (!r) return;
      addEvent(r, kind, { sender: senderById(r, senderId), text });
      saveRecords();
      queueRender();
    }
  };
  const engine = sample('campaignEngine', null)?.(api) || null;

  // Start: a fresh Dry Run first. Problems stop it; warnings do not. Then one confirmation.
  function requestStart() {
    if (activeRecord()) { ask({ title: 'Another campaign is running', text: 'Wait for it to finish, or stop it, before starting a new one.' }); return; }
    dryRun();
    if (view.dry.fails) { render(); return; }
    if (!engine) { ask({ title: 'No sending service', text: 'No sending service is connected, so nothing can be sent. Nothing was sent.' }); return; }
    const x = plan(), c = ch(), tpl = template();
    const rows = [['Type', draft.type === 'email' ? 'Email' : 'SMS'], ['Eligible', count(x.aud.totals.eligible)], ['Messages', count(x.msgs.list.length)], ['Template', esc(tpl.name)],
      ['Senders', `${count(x.r.ready.length)} ready, ${METHODS[c.method]}`], ['Starts', draft.schedule.when === 'now' ? 'Now' : esc(dateTime(+x.start))]];
    ask({ title: 'Start this campaign?', html: `<dl class="cp-meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`, ok: 'Start campaign' }).then(yes => { if (yes) startCampaign(); });
  }

  // The record keeps a copy of everything it was started with, so later edits never change its history.
  function startCampaign() {
    if (activeRecord()) return;
    const x = plan(), c = ch(), tpl = template(), now = Date.now(), later = draft.schedule.when === 'later', id = 'C' + now.toString(36).toUpperCase();
    const clean = t => ({ label: t.label, value: t.value, shown: t.shown });
    const record = {
      id, name: draft.name.trim() || 'Untitled campaign', type: draft.type, by: user.name, createdAt: now,
      status: later ? 'scheduled' : 'running', scheduledFor: later ? +x.start : 0, startedAt: later ? 0 : now, endedAt: 0, pausedAt: 0, pausedTotal: 0,
      snapshot: {
        filters: structuredClone(draft.filters), channel: structuredClone(c), notes: draft.notes,
        template: { name: tpl.name, subject: tpl.subject || '', body: tpl.body },
        senders: x.r.ready.map(s => ({ id: s.id, name: senderName(s), rep: s.rep, limit: s.limit, sentToday: s.sentToday })),
        totals: { ...x.aud.totals }, leadIds: x.aud.rows.map(r => r.lead.id)
      },
      messages: x.msgs.list.map((m, i) => {
        const pick = x.r.picks[i];
        return { id: `${id}:${i}`, leadId: m.lead.id, company: m.lead.company, rep: m.lead.rep, status: m.lead.status, to: clean(m.to), bcc: m.bcc.map(clean),
          senderId: pick.sender ? pick.sender.id : '', state: pick.sender ? 'queued' : 'skipped', reason: pick.sender ? '' : `no sender: ${pick.why}`, at: pick.sender ? 0 : now, attempts: 0 };
      }),
      senders: {}, events: []
    };
    record.messages.filter(m => m.state === 'skipped').forEach(m => addEvent(record, 'skipped', { m, text: m.reason }));
    if (!later) addEvent(record, 'started');
    records.unshift(record);
    saveRecords();
    claimLock();
    Object.assign(draft, blankDraft(), { step: 'live', record: id });
    Object.assign(view, { list: 'selected', dry: null, feed: 'all', feedQuery: '' });
    save();
    render();
    startHeartbeat();
    engine.start();
    $('campSteps').querySelector('[data-step="live"]')?.focus();
  }

  // Clone copies the audience filters and the setup. Everything is checked again, as for any new campaign.
  function cloneRecord(r) {
    const apply = () => {
      const b = blankDraft();
      const filters = { ...b.filters, ...structuredClone(r.snapshot.filters) };
      filters.reps = allowed(filters.reps);
      Object.assign(draft, b, { type: r.type, name: `${r.name} (copy)`, filters, notes: r.snapshot.notes,
        channels: { ...b.channels, [r.type]: fitChannel(structuredClone(r.snapshot.channel)) } });
      Object.assign(view, { list: 'selected', dry: null });
      if (view.drawer) setDrawer('', false);
      save();
      render();
      $('campName').focus();
    };
    if (isChanged()) ask({ title: 'Replace your draft?', text: 'Cloning replaces the campaign you are setting up now.', ok: 'Clone' }).then(yes => { if (yes) apply(); });
    else apply();
  }

  function openRecord(id) {
    const r = recordOf(id);
    view.screen = 'builder';
    Object.assign(draft, { record: id, step: RUNNING.includes(r.status) ? 'live' : 'results' });
    setDrawer('', false);
    save();
    render();
    $('campSteps').querySelector(`[data-step="${draft.step}"]`).focus();
  }

  // ── STEP 4 + 5: LIVE AND RESULTS ──
  // Processed: messages that reached an end (sent, delivered, failed, skipped). Cancelled ones (the campaign was stopped) are not.
  function stats(r) {
    const c = { queued: 0, sent: 0, delivered: 0, failed: 0, skipped: 0, cancelled: 0 };
    r.messages.forEach(m => { c[m.state] += 1; });
    const events = kind => r.events.filter(e => e.kind === kind).length;
    return { ...c, total: r.messages.length, processed: r.messages.length - c.queued - c.cancelled, sentAll: c.sent + c.delivered,
      replies: events('reply'), unsub: events('unsubscribed') + events('stop') };
  }
  const statusTag = r => tag(RUN_STATUS[r.status][1], `<b>${RUN_STATUS[r.status][0]}</b>`);
  const liveSenderState = (r, id) => (r.senders[id] || {}).state || 'ready';
  function healthLabel(r) {
    const states = r.snapshot.senders.map(s => liveSenderState(r, s.id));
    const ready = states.filter(x => !CANT_SEND.includes(x)).length, paused = states.filter(x => x === 'paused').length;
    return `${count(ready)} / ${count(states.length)} ready${paused ? ` — ${count(paused)} paused` : ''}`;
  }

  // Timers come from the record's own times, so they are right again after a reload.
  // Remaining uses the sends of the last 10 minutes; with fewer than 3 it is still calculating.
  function timers(r) {
    const now = Date.now();
    if (r.status === 'scheduled') return { next: countdown(r.scheduledFor) };
    const elapsed = clock((r.endedAt || now) - r.startedAt);
    if (r.status === 'paused') return { elapsed, remaining: 'Paused', finish: 'Paused', next: `Paused ${clock(now - r.pausedAt)}` };
    const from = Math.max(now - 10 * MIN, r.startedAt), span = now - from - (r.pausedTotal && from === r.startedAt ? r.pausedTotal : 0);
    const recent = r.messages.filter(m => ['sent', 'delivered', 'failed'].includes(m.state) && m.at >= from).length;
    const canSend = r.snapshot.senders.some(s => !CANT_SEND.includes(liveSenderState(r, s.id)));
    const left = r.messages.filter(m => m.state === 'queued').length, rest = recent >= 3 && span > 0 ? left / (recent / span) : null;
    const due = r.snapshot.senders.map(s => r.senders[s.id]).filter(st => st && st.nextAt && ['ready', 'cooldown', 'waiting'].includes(st.state)).map(st => st.nextAt);
    return {
      elapsed,
      remaining: !canSend ? 'Estimate unavailable' : rest === null ? 'Calculating…' : `~${clock(rest)}`,
      finish: canSend && rest !== null ? clockTime(now + rest) : '—',
      next: due.length ? (Math.min(...due) <= now ? 'Now' : shortClock(Math.min(...due) - now)) : '—'
    };
  }

  function progress(r, s) {
    const pct = s.total ? Math.floor(s.processed / s.total * 100) : 100;
    return `<div class="cp-bar" role="progressbar" aria-label="Campaign progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" data-state="${r.status}"><i style="width:${pct}%"></i></div>
      <b class="cp-pct">${pct}%</b><span class="cp-muted">${count(s.processed)} / ${count(s.total)} processed</span>`;
  }
  const counters = items => `<div class="cp-reasons cp-live-counts">${items.map(([k, n]) => `<span>${k} <b>${count(n)}</b></span>`).join('')}</div>`;

  function renderLive(r) {
    const s = stats(r), t = timers(r), scheduled = r.status === 'scheduled', canControl = engine && mine() && fullView(r);
    const toggle = !canControl || scheduled ? '' : r.status === 'running'
      ? '<button class="btn" type="button" data-act="pause" data-key="run-toggle">Pause</button>'
      : '<button class="btn primary" type="button" data-act="resume" data-key="run-toggle">Resume</button>';
    $('campRunTop').innerHTML = `
      <div class="cp-prog">${statusTag(r)}${progress(r, s)}
        <div class="cp-actions">${toggle}${canControl ? `<button class="btn" type="button" data-act="stop" data-key="run-stop">${scheduled ? 'Cancel' : 'Stop'}</button>` : ''}
          <button class="btn" type="button" data-drawer-open="queue" data-key="open-queue" aria-expanded="${view.drawer === 'queue'}" aria-controls="campDrawer">Advanced</button></div></div>
      ${!engine ? '<p class="cp-bad cp-pad">No sending service is connected, so this campaign cannot continue. Stop it, or connect the service.</p>'
        : !mine() ? '<p class="cp-bad cp-pad">This campaign is running in another tab. Switch to that tab to pause, resume or stop it — this tab takes over automatically if that one closes.</p>' : ''}
      <div class="cp-timers">${scheduled ? `<span>Starts <b>${esc(dateTime(r.scheduledFor))}</b></span><b class="cp-count" data-clock="next">${t.next}</b>`
        : `<span>Elapsed <b data-clock="elapsed">${t.elapsed}</b></span><span>Remaining <b data-clock="remaining">${t.remaining}</b></span>
          <span>Est. finish <b data-clock="finish">${t.finish}</b></span><span>Next activity <b data-clock="next">${t.next}</b></span>`}
        <button class="link-btn cp-right" type="button" data-drawer-open="health" data-key="open-health" aria-expanded="${view.drawer === 'health'}" aria-controls="campDrawer">Senders ${healthLabel(r)}</button>
      </div>
      ${counters([['Sent', s.sentAll], ...(r.type === 'sms' ? [['Delivered', s.delivered]] : []), ['Failed', s.failed], ['Skipped', s.skipped], ['Replies', s.replies], ['Unsubscribed', s.unsub], ['Remaining', s.queued]])}`;
  }

  function breakdown(title, rows) {
    return rows.length ? `<table class="cp-table cp-mini"><thead><tr><th scope="col">${title}</th><th scope="col" class="cp-num">Sent</th><th scope="col" class="cp-num">Failed</th><th scope="col" class="cp-num">Replies</th></tr></thead>
      <tbody>${rows.map(([name, v]) => `<tr><td>${esc(name)}</td><td class="cp-num">${count(v.sent)}</td><td class="cp-num">${count(v.failed)}</td><td class="cp-num">${count(v.replies)}</td></tr>`).join('')}</tbody></table>` : '';
  }
  function groupBy(r, keyOf) {
    const out = new Map();
    r.messages.filter(m => m.state !== 'queued' && m.state !== 'cancelled' && m.state !== 'skipped').forEach(m => {
      const k = keyOf(m), v = out.get(k) || { sent: 0, failed: 0, replies: 0 };
      if (m.state === 'failed') v.failed += 1; else v.sent += 1;
      if (m.reply) v.replies += 1;
      out.set(k, v);
    });
    return [...out];
  }

  function renderResults(r) {
    const s = stats(r), t = r.snapshot.totals, tpl = r.snapshot.template;
    const unused = r.snapshot.leadIds.reduce((n, id) => { const l = leadOf(id); return n + (l ? touchpoints(l, r.type).filter(x => x.state === 'never').length : 0); }, 0);
    const reasons = {};
    r.messages.filter(m => m.state === 'failed' || m.state === 'skipped').forEach(m => { reasons[m.reason] = (reasons[m.reason] || 0) + 1; });
    const reasonRows = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    $('campRunTop').innerHTML = `
      <div class="cp-prog">${statusTag(r)}${progress(r, s)}${s.cancelled ? `<span class="cp-bad">${count(s.cancelled)} cancelled</span>` : ''}
        <div class="cp-actions"><button class="btn primary" type="button" data-act="clone" data-key="clone">Clone</button></div></div>
      <div class="cp-timers">
        <span>Started <b>${r.startedAt ? esc(dateTime(r.startedAt)) : 'Never started'}</b></span><span>Ended <b>${esc(dateTime(r.endedAt))}</b></span>
        ${r.startedAt ? `<span>Took <b>${clock(r.endedAt - r.startedAt - r.pausedTotal)}</b></span>` : ''}
        <span>Template <b>${esc(tpl.name)}</b>${tpl.subject ? ` <span class="cp-muted">${esc(tpl.subject)}</span>` : ''}</span>
        ${r.snapshot.notes ? `<span>Note <b>${esc(r.snapshot.notes)}</b></span>` : ''}
      </div>
      ${counters([...(t ? [['Selected', t.selected], ['Eligible', t.eligible]] : []), ['Processed', s.processed], ['Sent', s.sentAll], ...(r.type === 'sms' ? [['Delivered', s.delivered]] : []),
        ['Failed', s.failed], ['Skipped', s.skipped], ['Replies', s.replies], ['Unsubscribed', s.unsub], ['Cancelled', s.cancelled], ['Unused Touchpoints', unused]])}
      <div class="cp-breaks">
        ${breakdown('Rep', groupBy(r, m => repName(m.rep)))}
        ${breakdown('Sender', groupBy(r, m => senderById(r, m.senderId).name))}
        ${reasonRows.length ? `<table class="cp-table cp-mini"><thead><tr><th scope="col">Failed or skipped because</th><th scope="col" class="cp-num">Messages</th></tr></thead>
          <tbody>${reasonRows.map(([k, n]) => `<tr><td>${esc(k)}</td><td class="cp-num">${count(n)}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>`;
  }

  function renderFeed(r) {
    $('campFeedFilters').innerHTML = Object.entries(FEED).map(([k, [name]]) =>
      `<button type="button" data-feed="${k}" data-key="feed-${k}" aria-pressed="${view.feed === k}">${name}</button>`).join('');
    const q = view.feedQuery.trim().toLowerCase(), wrap = $('campFeedWrap'), top = wrap.scrollTop;
    const rows = r.events.filter(e => FEED[view.feed][1](e.kind) && (!q || `${e.company} ${e.rep} ${e.recipient} ${e.sender} ${e.text}`.toLowerCase().includes(q)));
    $('campFeed').innerHTML = rows.length ? `<thead><tr><th scope="col">Time</th><th scope="col">Company</th><th scope="col">Rep</th><th scope="col">Recipient</th>
      <th scope="col">Sender</th><th scope="col">Template</th><th scope="col">Result</th></tr></thead><tbody>${rows.map(e => {
        const [word, tone] = EVENTS[e.kind];
        return `<tr><td class="cp-time">${showTime(e.at, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</td>
          <td>${e.leadId ? `<span class="cp-lead-name">${esc(e.company)}</span><button class="open-record" type="button" data-lead="${e.leadId}" title="Open record" aria-label="Open ${esc(e.company)} in Leads">${ic('open', 12)}</button>` : '—'}</td>
          <td>${e.leadId ? esc(repName(e.rep)) : '—'}</td><td>${esc(e.recipient) || '—'}</td><td>${esc(e.sender) || '—'}</td><td>${esc(e.template) || '—'}</td>
          <td>${tag(tone, `<b>${word}</b>${e.text ? ' — ' + esc(e.text) : ''}`)}</td></tr>`;
      }).join('')}</tbody>` : '';
    $('campFeedEmpty').hidden = rows.length > 0;
    $('campFeedEmpty').textContent = r.events.length ? 'Nothing matches.' : 'Events show here as they happen.';
    wrap.scrollTop = $('campAutoScroll').checked ? wrap.scrollHeight : top;
  }

  // ── DRAWER: advanced filters, senders, protection, history, sender health, advanced ──
  function checks(title, key, list, attr) {
    const opts = OPTIONS[key]();
    if (!opts.length) return '';
    return `<fieldset class="cp-group"><legend>${title}</legend><div class="cp-opts">${opts.map(v =>
      `<label class="cp-check"><input type="checkbox" ${attr}="${key}" data-key="${key}-${esc(v)}" value="${esc(v)}"${list.includes(v) ? ' checked' : ''}>${esc(optionName(key, v))}</label>`).join('')}</div></fieldset>`;
  }
  const num = (attr, key, value, range, label, blank = false) =>
    `<input class="input cp-w-s" type="text" inputmode="numeric" ${attr}="${key}" data-key="${key}" data-num="${range}"${blank ? ' data-blank' : ''} value="${value}" aria-label="${label}" autocomplete="off">`;
  const check = (attr, key, on, label) => `<label class="cp-check"><input type="checkbox" ${attr}="${key}" data-key="${key}"${on ? ' checked' : ''}>${label}</label>`;

  function filtersBody() {
    const f = draft.filters, timed = f.last === 'within' || f.last === 'outside';
    const lastOpts = [['any', 'Any time'], ['never', 'Never contacted'], ['within', 'Contacted in the last'], ['outside', 'Not contacted in the last']];
    return `${checks('State', 'states', f.states, 'data-list')}
      ${checks('Industry', 'industries', f.industries, 'data-list')}
      <fieldset class="cp-group"><legend>Revenue</legend><div class="cp-line">
        <input class="input cp-w-m" data-f="revMin" data-key="revMin" type="text" inputmode="numeric" placeholder="From $0" autocomplete="off" value="${esc(f.revMin)}" aria-label="Revenue from" aria-invalid="${badAmount(f.revMin)}">
        <span>to</span>
        <input class="input cp-w-m" data-f="revMax" data-key="revMax" type="text" inputmode="numeric" placeholder="Any" autocomplete="off" value="${esc(f.revMax)}" aria-label="Revenue to" aria-invalid="${badAmount(f.revMax)}">
      </div></fieldset>
      <fieldset class="cp-group"><legend>Last contacted</legend><div class="cp-line">
        <select class="input" data-f="last" data-key="last" aria-label="Last contacted">${lastOpts.map(([v, t]) => `<option value="${v}"${f.last === v ? ' selected' : ''}>${t}</option>`).join('')}</select>
        ${timed ? `${num('data-f', 'days', f.days, '1,3650', 'Days')}<span>days</span>` : ''}
      </div></fieldset>
      <fieldset class="cp-group"><legend>Must have</legend><div class="cp-opts">
        ${check('data-f', 'hasEmail', f.hasEmail, 'An email')}${check('data-f', 'hasMobile', f.hasMobile, 'A mobile number')}
      </div></fieldset>
      ${checks(draft.type === 'email' ? 'Send to these emails' : 'Send to these mobiles', 'fields', f.fields, 'data-list')}`;
  }

  function sendersBody() {
    const c = ch(), single = c.method === 'single', list = senders();
    if (!list.length) return `<p class="cp-note">No ${draft.type === 'email' ? 'email accounts' : 'iPhones'} are connected.</p>`;
    return `<div class="cp-group">
        ${single ? '<p class="cp-note">Pick the one sender for this campaign.</p>' : check('data-sender-all', 'all', !c.senders.length, 'All ready senders')}
      </div>
      <ul class="cp-senders">${list.map(s => {
        const st = senderState(s), problem = senderProblem(s), on = single ? c.senders[0] === s.id : c.senders.includes(s.id);
        return `<li><label class="cp-sender"><input type="${single ? 'radio' : 'checkbox'}" name="campSender" data-sender="${s.id}" data-key="sender-${s.id}"${on ? ' checked' : ''}>
          <span class="cp-sender-main"><b>${esc(s.name)}</b>${s.number ? ` ${fmtPhone(s.number)}` : ''}
            <span class="cp-sub">${esc(repName(s.rep))} · ${count(s.sentToday)} of ${count(s.limit)} sent today · last send ${timeAgo(s.lastSend)}${s.heartbeat ? ` · checked in ${timeAgo(s.heartbeat)}` : ''}</span>
            ${problem ? `<span class="cp-bad">${esc(problem)}</span>` : ''}</span>
          ${tag(SENDER[st][1], `<b>${SENDER[st][0]}</b>`)}</label></li>`;
      }).join('')}</ul>`;
  }

  function protectionBody() {
    const p = prot(), issues = protectionIssues(), n = (key, range, label, blank) => num('data-p', key, p[key], range, label, blank);
    const pace = p.delay === 'range' ? `${n('min', '1,3600', 'Shortest wait in seconds')}<span>to</span>${n('max', '1,3600', 'Longest wait in seconds')}<span>seconds between sends</span>`
      : `${n('min', '1,3600', 'Seconds between sends')}<span>seconds between sends</span>`;
    return `${issues.length ? `<p class="cp-warn cp-group">Caution: ${esc(issues.join(', '))}.</p>` : ''}
      <fieldset class="cp-group"><legend>Pacing</legend>
        <div class="cp-line"><select class="input" data-p="delay" data-key="delay" aria-label="Pacing">${Object.entries(DELAYS).map(([v, t]) => `<option value="${v}"${p.delay === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="cp-line">${pace}</div>
        ${p.delay === 'batch' ? `<div class="cp-line">${n('batchSize', '1,1000', 'Messages per batch')}<span>per batch, then wait</span>${n('batchWait', '1,1440', 'Minutes between batches')}<span>minutes</span></div>` : ''}
        ${check('data-p', 'autoSlow', p.autoSlow, 'Slow down when a provider or phone reports rate limits')}
      </fieldset>
      <fieldset class="cp-group"><legend>Limits</legend>
        <div class="cp-line">${n('hourly', '1,1000', 'Per sender per hour')}<span>per sender per hour</span></div>
        <div class="cp-line">${n('daily', '1,10000', 'Per sender per day', true)}<span>per sender per day (blank: each sender’s own limit)</span></div>
        <div class="cp-line">${n('campaignMax', '1,1000000', 'Most messages for this campaign', true)}<span>most messages for this campaign (blank: no limit)</span></div>
      </fieldset>
      <fieldset class="cp-group"><legend>Send window</legend>
        ${check('data-p', 'windowOn', p.windowOn, 'Only send inside a window, in the lead’s local time')}
        ${p.windowOn ? `<div class="cp-line"><input class="input cp-w-m" type="time" data-p="windowStart" data-key="windowStart" value="${p.windowStart}" aria-label="Window opens">
          <span>to</span><input class="input cp-w-m" type="time" data-p="windowEnd" data-key="windowEnd" value="${p.windowEnd}" aria-label="Window closes"></div>` : ''}
      </fieldset>
      <fieldset class="cp-group"><legend>Cooldown</legend>
        <div class="cp-line"><span>Skip contacts reached in the last</span>${n('cooldown', '0,365', 'Cooldown days')}<span>days (0: off)</span></div>
      </fieldset>
      <fieldset class="cp-group"><legend>Stop rules</legend>
        ${check('data-p', 'stopOnReply', p.stopOnReply, 'Stop sending to a lead who replies')}
        <div class="cp-line cp-wrap"><span>Stop when a lead moves to</span>${['ENGAGED', 'CONTRACT'].map(s =>
          `<label class="cp-check"><input type="checkbox" data-plist="stopStatuses" data-key="stop-${s}" value="${s}"${p.stopStatuses.includes(s) ? ' checked' : ''}>${s}</label>`).join('')}</div>
      </fieldset>
      <fieldset class="cp-group"><legend>Failures</legend>
        <div class="cp-line"><span>Retry a failed send</span><select class="input" data-p="retries" data-key="retries" data-num="0,2" aria-label="Retries">${[[0, 'Never'], [1, 'Once'], [2, 'Twice']].map(([v, t]) => `<option value="${v}"${p.retries === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="cp-line"><span>Pause a sender after</span>${n('pauseAfter', '0,50', 'Failures in a row')}<span>failures in a row (0: never)</span></div>
        <div class="cp-line"><span>Pause the campaign if more than</span>${n('pauseRate', '1,100', 'Failure percent')}<span>% fail</span></div>
      </fieldset>`;
  }

  function historyBody() {
    const list = visibleRecords();
    if (!list.length) return '<p class="cp-note">No campaigns yet. Campaigns you start show here.</p>';
    return `<ul class="cp-senders">${list.map(r => {
      const s = stats(viewOf(r));
      return `<li class="cp-sender"><button class="cp-hist" type="button" data-record="${r.id}" data-key="rec-${r.id}"><b>${esc(r.name)}</b> ${statusTag(r)}
          <span class="cp-sub">${r.type === 'email' ? 'Email' : 'SMS'} · ${esc(dateTime(r.startedAt || r.scheduledFor || r.createdAt))} · ${count(s.processed)} / ${count(s.total)} processed</span></button>
        <button class="link-btn" type="button" data-clone="${r.id}" data-key="clone-${r.id}">Clone</button></li>`;
    }).join('')}</ul>`;
  }
  function healthBody() {
    const r = viewOf(shownRecord());
    if (!r) return '<p class="cp-note">No campaign is on screen.</p>';
    const live = RUNNING.includes(r.status) && engine && mine() && fullView(r);
    return `<ul class="cp-senders">${r.snapshot.senders.map(s => {
      const st = r.senders[s.id] || {}, state = st.state || 'ready', [word, tone] = SENDER[state];
      return `<li class="cp-sender"><span class="cp-sender-main"><b>${esc(s.name)}</b>
          <span class="cp-sub">${esc(repName(s.rep))} · ${count(st.sent || 0)} sent in this campaign</span>
          ${st.note ? `<span class="cp-sub">${esc(st.note)}</span>` : ''}
          ${live && st.nextAt && !CANT_SEND.includes(state) ? `<span class="cp-count" data-next="${st.nextAt}"></span>` : ''}</span>
        ${tag(tone, `<b>${word}</b>`)}
        ${live ? `<button class="link-btn" type="button" data-sender-act="${state === 'paused' ? 'resumeSender' : 'pauseSender'}" data-id="${s.id}" data-key="sa-${s.id}">${state === 'paused' ? 'Resume' : 'Pause'}</button>` : ''}</li>`;
    }).join('')}</ul>`;
  }
  function queueBody() {
    const r = viewOf(shownRecord());
    if (!r) return '<p class="cp-note">No campaign is on screen.</p>';
    const canRemove = mine() && fullView(r), waiting = r.messages.filter(m => m.state === 'queued');
    return `<p class="cp-note">Protection: ${esc(protectionSummary(protOf(r)))}.</p>
      ${waiting.length ? `<ul class="cp-senders">${waiting.map(m => `<li class="cp-sender"><span class="cp-sender-main"><b>${esc(m.company)}</b>
          <span class="cp-sub">${esc(m.to.label)} ${esc(m.to.shown)} · ${esc(senderById(r, m.senderId).name)}</span></span>
        ${canRemove ? `<button class="link-btn" type="button" data-remove="${m.id}" data-key="rm-${m.id}">Remove</button>` : ''}</li>`).join('')}</ul>` : '<p class="cp-note">Nothing is waiting to send.</p>'}`;
  }

  const DRAWERS = {
    filters: { title: () => 'Advanced filters', reset: 'Clear', body: filtersBody,
      foot: () => { const t = audience().totals; return `<b>${count(t.eligible)}</b> eligible of ${count(t.selected)}`; } },
    senders: { title: () => draft.type === 'email' ? 'Email accounts' : 'iPhones', reset: '', body: sendersBody,
      foot: () => { const pool = chosen(); return `<b>${count(pool.filter(isReady).length)}</b> ready of ${count(pool.length)} in use`; } },
    protection: { title: () => 'Protection', reset: 'Reset to defaults', body: protectionBody, foot: () => `Protection ${protectionTag()}` },
    history: { title: () => 'History', reset: '', body: historyBody, foot: () => plural(visibleRecords().length, 'campaign'), live: true },
    health: { title: () => 'Senders', reset: '', body: healthBody, foot: () => shownRecord() ? healthLabel(viewOf(shownRecord())) : '', live: true },
    queue: { title: () => 'Advanced', reset: '', body: queueBody, foot: () => `${count(shownRecord() ? viewOf(shownRecord()).messages.filter(m => m.state === 'queued').length : 0)} waiting to send`, live: true }
  };

  function renderDrawer() {
    const d = DRAWERS[view.drawer];
    $('campDrawerTitle').textContent = d.title();
    $('campDrawerReset').textContent = d.reset;
    $('campDrawerReset').hidden = !d.reset;
    keepFocus(() => { $('campDrawerBody').innerHTML = d.body(); });
    $('campDrawerCount').innerHTML = d.foot();
  }

  function setDrawer(kind, returnFocus = true) {
    const was = view.drawer;
    view.drawer = kind;
    page.querySelectorAll('[data-drawer-open]').forEach(b => b.setAttribute('aria-expanded', b.dataset.drawerOpen === kind));
    drawer.classList.toggle('open', !!kind);
    drawer.inert = !kind;
    if (kind) { renderDrawer(); drawer.querySelector('button:not([data-drawer="close"]), input, select, textarea')?.focus(); }
    else if (returnFocus && was) page.querySelector(`[data-drawer-open="${was}"]`)?.focus();
  }
  document.addEventListener('mousedown', e => {
    if (view.drawer && !drawer.contains(e.target) && !e.target.closest('[data-drawer-open]')) setDrawer('');
  });

  // Filters and protection: typed fields save as they are typed; boxes and lists redraw the drawer.
  $('campDrawerBody').addEventListener('input', e => {
    const el = e.target, key = el.dataset.f || el.dataset.p;
    if (!key || el.type === 'checkbox' || el.tagName === 'SELECT') return;
    if (key === 'revMin' || key === 'revMax') {
      el.setAttribute('aria-invalid', badAmount(el.value));
      draft.filters[key] = el.value;
    } else {
      const value = readField(el), p = prot();
      const bad = value === undefined || (el.dataset.p && p.delay === 'range' && ((key === 'min' && value > p.max) || (key === 'max' && value < p.min)));
      el.setAttribute('aria-invalid', bad);
      if (bad) return;
      (el.dataset.f ? draft.filters : p)[key] = value;
    }
    changed();
  });
  $('campDrawerBody').addEventListener('change', e => {
    const el = e.target, c = ch();
    if (el.type !== 'checkbox' && el.type !== 'radio' && el.tagName !== 'SELECT') return;
    if (el.dataset.list) { const k = el.dataset.list; draft.filters[k] = el.checked ? [...draft.filters[k], el.value] : draft.filters[k].filter(v => v !== el.value); }
    else if (el.dataset.plist) { const p = prot(); p.stopStatuses = el.checked ? [...p.stopStatuses, el.value] : p.stopStatuses.filter(v => v !== el.value); }
    else if (el.dataset.sender) c.senders = el.type === 'radio' ? [el.dataset.sender] : el.checked ? [...c.senders, el.dataset.sender] : c.senders.filter(v => v !== el.dataset.sender);
    else if (el.hasAttribute('data-sender-all')) c.senders = [];
    else if (el.dataset.f) draft.filters[el.dataset.f] = readField(el);
    else if (el.dataset.p) prot()[el.dataset.p] = readField(el);
    changed();
    renderDrawer();
  });

  // History, sender health and the queue.
  $('campDrawerBody').addEventListener('click', e => {
    const b = e.target.closest('[data-record], [data-clone], [data-sender-act], [data-remove]');
    if (!b) return;
    if (b.dataset.record) openRecord(b.dataset.record);
    else if (b.dataset.clone) cloneRecord(recordOf(b.dataset.clone));
    else if (b.dataset.senderAct) { if (mine() && fullView(shownRecord())) { engine[b.dataset.senderAct](b.dataset.id); renderDrawer(); } }
    else {
      if (!mine() || !fullView(shownRecord())) return;
      const [r, m] = findMessage(b.dataset.remove);
      if (!m || m.state !== 'queued') return;
      const before = m.at;
      settle(r, m, 'skipped', 'removed by you');
      const event = r.events[r.events.length - 1];
      const redraw = () => { saveRecords(); renderDrawer(); queueRender(); };
      redraw();
      // Undo puts it back in the queue while the campaign still runs. Once it has ended there is no queue to go back to.
      toast(`${m.company} removed from the queue.`, [{ label: 'Undo', run: () => {
        if (activeRecord() !== r || m.state !== 'skipped') { toast('Can’t undo — this campaign has ended.'); return; }
        Object.assign(m, { state: 'queued', reason: '', at: before });
        r.events.splice(r.events.indexOf(event), 1);
        redraw();
      } }]);
    }
  });

  drawer.addEventListener('click', e => {
    const act = e.target.closest('[data-drawer]')?.dataset.drawer;
    if (act === 'close') setDrawer('');
    if (act === 'reset') {
      if (view.drawer === 'filters') {
        const blank = blankFilters();
        ['states', 'industries', 'revMin', 'revMax', 'last', 'days', 'hasEmail', 'hasMobile', 'fields'].forEach(k => { draft.filters[k] = blank[k]; });
      } else ch().protection = blankProtection(draft.type);
      changed();
      renderDrawer();
    }
  });

  // ── REP / STATUS MENU ──
  // Status: All means no status is picked. Reps: All checks every rep, and it shows only when there is more than one.
  function renderMenu() {
    const key = view.menu, list = draft.filters[key], opts = OPTIONS[key]();
    const allOn = key === 'reps' ? list.length === opts.length : !list.length;
    menu.setAttribute('aria-label', key === 'reps' ? 'Reps' : 'Lead status');
    menu.innerHTML = (key === 'reps' && opts.length < 2 ? '' : `<label class="cp-check"><input type="checkbox" data-all${allOn ? ' checked' : ''}>All</label>`)
      + opts.map(v => `<label class="cp-check"><input type="checkbox" value="${esc(v)}"${list.includes(v) ? ' checked' : ''}>${esc(optionName(key, v))}</label>`).join('');
  }
  function openMenu(button) {
    view.menu = button.dataset.menu;
    view.menuButton = button;
    renderMenu();
    const r = button.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = r.bottom + 4 + 'px';
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('input').focus();
  }
  function closeMenu(returnFocus) {
    if (!view.menu) return;
    menu.hidden = true;
    view.menuButton.setAttribute('aria-expanded', 'false');
    if (returnFocus) view.menuButton.focus();
    view.menu = '';
    view.menuButton = null;
  }
  menu.addEventListener('change', e => {
    const key = view.menu, f = draft.filters, input = e.target;
    if (input.hasAttribute('data-all')) f[key] = key === 'reps' && input.checked ? [...OPTIONS.reps()] : [];
    else {
      const next = input.checked ? [...f[key], input.value] : f[key].filter(v => v !== input.value);
      f[key] = key === 'statuses' && next.length === OPTIONS[key]().length ? [] : next;
    }
    renderMenu();
    menu.querySelector(input.hasAttribute('data-all') ? '[data-all]' : `input[value="${CSS.escape(input.value)}"]`).focus();
    changed();
  });
  // Up/Down move focus between the checkboxes so the menu can be used from the keyboard alone.
  menu.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll('input')], i = items.indexOf(document.activeElement);
    if (i === -1) return;
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next.focus();
  });
  document.addEventListener('mousedown', e => {
    if (view.menu && !menu.contains(e.target) && !view.menuButton.contains(e.target)) closeMenu(false);
  });

  // ── PREVIEW WINDOW ──
  function openPreview() {
    view.preview = null;
    renderPreview();
    dialog.showModal();
  }
  dialog.addEventListener('click', e => { if (e.target.closest('[data-dialog="close"]')) dialog.close(); });
  dialog.addEventListener('mousedown', e => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('change', e => {
    if (!e.target.matches('[data-preview]')) return;
    view.preview = Number(e.target.value);
    renderPreview();
    dialog.querySelector('[data-preview]').focus();
  });

  // ── DRAWING ──
  function save() {
    $('campSaved').textContent = store.write('nv.campaignDraft', draft) ? 'Draft saved' : '';
  }

  // Audience, Setup and Review are always open. Live needs a running (or scheduled) campaign; Results a finished one.
  function renderTop() {
    const active = activeRecord(), shown = recordOf(draft.record), onRun = draft.step === 'live' || draft.step === 'results', run = shownRecord();
    const open = { audience: true, setup: true, review: true, live: !!active, results: !!shown && !RUNNING.includes(shown.status) };
    const currentStep = STEPS.indexOf(draft.step);
    $('campType').querySelectorAll('[data-type]').forEach(b => {
      const on = b.dataset.type === draft.type;
      b.setAttribute('aria-checked', on);
      b.tabIndex = on ? 0 : -1;
    });
    $('campType').hidden = true;
    $('campName').hidden = $('campSaved').hidden = onRun;
    $('campTitle').hidden = !onRun;
    if (onRun) $('campTitle').innerHTML = `${run.type === 'email' ? 'Email' : 'SMS'} <b>${esc(run.name)}</b>`;
    keepFocus(() => {
      $('campSteps').innerHTML = STEPS.map((s, i) => {
        const name = s[0].toUpperCase() + s.slice(1);
        const state = i === currentStep ? 'current' : i < currentStep ? 'complete' : 'future';
        return `<li data-step-state="${state}">${open[s] ? `<button type="button" data-step="${s}" data-key="step-${s}"${s === draft.step ? ' aria-current="step"' : ''}>${name}</button>` : name}</li>`;
      }).join('');
    });
    const next = { audience: 'Next: Setup', setup: 'Next: Review', review: 'Start campaign' }[draft.step];
    const board = ['audience', 'setup', 'review'].includes(draft.step);
    $('campSteps').hidden = false;
    $('campNext').hidden = board || !next;
    if (next) $('campNext').textContent = next;
  }

  // One clock for the page: the scheduled-start countdowns and the Live timers. It runs only while one is on screen.
  function tick() {
    if (view.screen === 'overview') { clearInterval(ticker); ticker = 0; return; }
    const els = page.hidden ? [] : page.querySelectorAll('[data-countdown], [data-clock], [data-next]');
    if (!els.length) { clearInterval(ticker); ticker = 0; return; }
    const r = draft.step === 'live' ? viewOf(activeRecord()) : null, t = r && timers(r);
    els.forEach(el => {
      if (el.dataset.countdown) el.textContent = countdown(Number(el.dataset.countdown));
      else if (el.dataset.clock) el.textContent = t ? t[el.dataset.clock] : '';
      else el.textContent = r && r.status === 'paused' ? 'Paused' : Number(el.dataset.next) <= Date.now() ? 'Next send: now' : `Next send in ${shortClock(Number(el.dataset.next) - Date.now())}`;
    });
  }
  function startTicker() {
    if (!ticker && page.querySelector('[data-countdown], [data-clock], [data-next]')) ticker = setInterval(tick, 1000);
    tick();
  }

  function renderStep() {
    keepFocus(() => {
      if (draft.step === 'audience') renderAudience();
      else if (draft.step === 'setup') renderSetup();
      else if (draft.step === 'review') renderReview();
      else {
        const r = viewOf(shownRecord());
        if (draft.step === 'live') renderLive(r); else renderResults(r);
        renderFeed(r);
      }
    });
    if (view.drawer && DRAWERS[view.drawer].live) renderDrawer();
    else if (view.drawer) $('campDrawerCount').innerHTML = DRAWERS[view.drawer].foot();
    startTicker();
  }

  // A step that has nothing to show falls back: Live → Results → Audience.
  function checkStep() {
    const shown = recordOf(draft.record);
    if (draft.step === 'live' && !activeRecord()) draft.step = shown ? 'results' : 'audience';
    if (draft.step === 'results' && (!shown || RUNNING.includes(shown.status))) draft.step = 'audience';
  }

  function withType(type, fn) {
    const prev = draft.type;
    draft.type = type;
    try { return fn(); } finally { draft.type = prev; }
  }
  function channelCard(type) {
    return withType(type, () => {
      const c = ch(), tpls = templates(), tpl = template(), aud = audience();
      const names = aud.rows.filter(r => r.eligible).slice(0, 5).map(r => esc(r.lead.company));
      const fails = view.dry && view.dry.type === type ? view.dry.checks.filter(x => x[0] === 'fail') : [];
      const label = type === 'email' ? 'Email' : 'SMS';
      return `<h2>${label}</h2>
        <div class="cp-field"><h3>Audience</h3><p>${count(aud.totals.eligible)} eligible</p><p>${names.join(', ') || 'No one eligible yet.'}</p>${drawerButton('filters', 'Filters')}</div>
        <div class="cp-field"><h3>Template</h3>
          <select class="input" data-s="template" aria-label="${label} template">
            <option value="">${tpls.length ? 'Choose a template' : 'No templates yet'}</option>
            ${tpls.map(t => `<option value="${esc(t.id)}"${t.id === c.template ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
          ${tpl && type === 'email' ? `<p>Subject: ${esc(tpl.subject || '')}</p>` : ''}
          <button class="btn" type="button" data-act="templates">Templates</button>
        </div>
        <div class="cp-field"><h3>Senders</h3>
          <select class="input" data-s="method" aria-label="${label} senders">
            ${Object.entries(METHODS).map(([v, t]) => `<option value="${v}"${v === c.method ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
          <p>${senderSummary()}</p>${drawerButton('senders', type === 'email' ? 'Email accounts' : 'Phones')}
        </div>
        ${type === 'email' ? `<div class="cp-field"><h3>Send mode</h3>${seg('mode', c.mode, [['individual', 'Individual'], ['bcc', 'BCC']], 'Send mode')}</div>` : ''}
        <div class="cp-field"><h3>Schedule</h3>${scheduleValue()}</div>
        ${fails.length ? `<ul class="cp-checks">${fails.map(([, text]) => `<li data-level="fail"><span>${esc(text)}</span></li>`).join('')}</ul>` : ''}
        <button class="btn primary" type="button" data-act="start">Start ${label}</button>`;
    });
  }
  function renderBoard() {
    $('campCardEmail').innerHTML = channelCard('email');
    $('campCardSms').innerHTML = channelCard('sms');
  }

  function renderOverview() {
    const examples = [
      ['October re-engagement', 'Email', '1,240', '38.4%', 'Running', 'live'],
      ['Offer follow-up · East', 'SMS', '486', '24.7%', 'Scheduled', 'scheduled'],
      ['Document reminder series', 'Email', '812', '31.2%', 'Completed', 'done'],
      ['Renewal check-in', 'SMS', '264', '19.8%', 'Completed', 'done'],
      ['Pre-approval check-in', 'SMS', '396', '18.6%', 'Completed', 'done'],
      ['Monthly statement reminder', 'Email', '540', '27.1%', 'Completed', 'done'],
      ['Application welcome series', 'Email', '688', '35.2%', 'Completed', 'done']
    ];
    $('campOverview').innerHTML = `
      <header class="ops-campaign-head"><div><span class="ops-eyebrow">SAMPLE CAMPAIGN DATA · PREVIEW ONLY</span><h2>Campaign pulse</h2><p>Illustrative delivery and engagement figures. This view does not send messages or create campaign records.</p></div><button class="btn primary" type="button" data-camp-screen="builder">Open campaign builder</button></header>
      <div class="ops-campaign-kpis">
        <article class="ops-campaign-kpi"><span>Active campaigns</span><b>04</b><small><i class="ops-kpi-dot blue"></i>2 email · 2 SMS</small></article>
        <article class="ops-campaign-kpi"><span>Delivered</span><b>18,420</b><small><i class="ops-kpi-dot teal"></i>96.8% delivery rate</small></article>
        <article class="ops-campaign-kpi"><span>Engagement</span><b>32.6%</b><small><i class="ops-kpi-dot violet"></i>+4.2 pts vs. prior</small></article>
        <article class="ops-campaign-kpi"><span>Attributed pipeline</span><b>$428K</b><small><i class="ops-kpi-dot amber"></i>Illustrative estimate</small></article>
      </div>
      <div class="ops-campaign-grid">
        <section class="ops-panel ops-campaign-list" aria-label="Sample recent campaigns">
          <header class="ops-panel-head"><div><span class="ops-eyebrow">RECENT WORK</span><h3>Campaigns</h3></div><span class="ops-panel-note">All values are sample data</span></header>
          <div class="ops-campaign-table"><div class="ops-campaign-table-head"><span>Campaign</span><span>Channel</span><span>Audience</span><span>Engagement</span><span>Status</span></div>
            ${examples.map(([name, channel, audience, engagement, status, tone]) => `<div class="ops-campaign-row"><span><b>${name}</b><small>Created ${status === 'Running' ? 'today' : 'this week'}</small></span><span class="ops-channel-type" data-channel="${channel.toLowerCase()}">${channel}</span><span>${audience}</span><b>${engagement}</b><span class="ops-status-text" data-tone="${tone}"><i></i>${status}</span></div>`).join('')}
          </div>
        </section>
        <section class="ops-panel ops-insights" aria-label="Sample campaign insights">
          <header class="ops-panel-head"><div><span class="ops-eyebrow">SAMPLE INSIGHTS</span><h3>Next best moves</h3></div><span class="ops-insight-count">05</span></header>
          <div class="ops-insight-row"><span class="ops-insight-number">01</span><span><b>Revisit the 2-day follow-up</b><small>Sample replies peak 2–4 hours after delivery.</small></span><span class="ops-insight-arrow">↗</span></div>
          <div class="ops-insight-row"><span class="ops-insight-number">02</span><span><b>Prioritize warm conversations</b><small>126 sample replies are ready for a rep touch.</small></span><span class="ops-insight-arrow">↗</span></div>
          <div class="ops-insight-row"><span class="ops-insight-number">03</span><span><b>Keep the quiet window</b><small>Evening deliveries show lower engagement.</small></span><span class="ops-insight-arrow">↗</span></div>
          <div class="ops-insight-row"><span class="ops-insight-number">04</span><span><b>Test concise subject lines</b><small>Shorter samples are opened more often on mobile.</small></span><span class="ops-insight-arrow">↗</span></div>
          <div class="ops-insight-row"><span class="ops-insight-number">05</span><span><b>Protect list quality</b><small>Keep the sample suppression rate below 1%.</small></span><span class="ops-insight-arrow">↗</span></div>
        </section>
      </div>`;
  }

  function render() {
    closeMenu(false);
    checkStep();
    const overview = view.screen === 'overview';
    $('campOverview').hidden = !overview;
    $('campBuilder').hidden = overview;
    if (overview) renderOverview();
    $('campName').value = draft.name;
    $('campTouch').value = draft.filters.touch;
    $('campSearch').value = draft.filters.search;
    $('campFeedSearch').value = view.feedQuery;
    const board = ['audience', 'setup', 'review'].includes(draft.step);
    Object.entries(SECTIONS).forEach(([id, steps]) => { $(id).hidden = board || !steps.includes(draft.step); });
    $('campBoard').hidden = !board;
    $('campTemplates').hidden = true;
    view.tplOpen = false;
    renderTop();
    if (board) renderBoard();
    else renderStep();
    if (view.drawer) renderDrawer();
  }

  // Every change goes through here: save the draft, then redraw what depends on it.
  function changed() {
    save();
    renderTop();
    if (['audience', 'setup', 'review'].includes(draft.step)) renderBoard();
    else renderStep();
  }

  function setStep(step) {
    if (step === draft.step) return;
    if (view.drawer) setDrawer('', false);
    if (step === 'live') draft.record = activeRecord().id;
    draft.step = step;
    save();
    render();
  }

  // ── TOP ROW ──
  function setType(type) {
    if (type === draft.type) return;
    const apply = () => {
      draft.type = type;
      draft.filters.fields = [];
      if (view.drawer) renderDrawer();
      changed();
      $('campType').querySelector(`[data-type="${type}"]`).focus();
    };
    if (draft.filters.fields.length) {
      const from = draft.type === 'email' ? 'emails' : 'mobiles';
      ask({ title: `Switch to ${type === 'email' ? 'Email' : 'SMS'}?`, text: `The ${from} you picked to send to will be cleared.`, ok: 'Switch' }).then(yes => { if (yes) apply(); });
    } else apply();
  }
  $('campType').addEventListener('click', e => {
    const b = e.target.closest('[data-type]');
    if (b) setType(b.dataset.type);
  });
  $('campName').addEventListener('input', e => { draft.name = e.target.value; save(); });
  more.addEventListener('toggle', () => moreSummary.setAttribute('aria-expanded', more.open));
  more.addEventListener('click', e => { if (e.target.closest('.cp-more-menu button')) more.open = false; });
  document.addEventListener('pointerdown', e => { if (more.open && !more.contains(e.target)) more.open = false; });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !more.open) return;
    e.preventDefault();
    e.stopPropagation();
    more.open = false;
    moreSummary.focus();
  }, true);
  $('campSteps').addEventListener('click', e => { const b = e.target.closest('[data-step]'); if (b) setStep(b.dataset.step); });
  $('campNext').addEventListener('click', () => {
    if (draft.step === 'review') { requestStart(); return; }
    setStep(STEPS[STEPS.indexOf(draft.step) + 1]);
    $('campSteps').querySelector(`[data-step="${draft.step}"]`).focus();
  });
  $('campNew').addEventListener('click', () => {
    const start = () => {
      view.screen = 'builder';
      Object.assign(draft, blankDraft(), { record: draft.record });
      Object.assign(view, { list: 'selected', dry: null });
      if (view.drawer) setDrawer('', false);
      save();
      render();
      $('campName').focus();
    };
    if (isChanged()) ask({ title: 'Start a new campaign?', text: 'This clears the name, audience, setup and schedule you have set.', ok: 'Start new' }).then(yes => { if (yes) start(); });
    else start();
  });
  $('campTplBtn').addEventListener('click', () => setTplOpen(!view.tplOpen));
  $('campTemplates').addEventListener('click', e => {
    const pick = e.target.closest('[data-tpl-id]');
    if (pick) { view.tplId = pick.dataset.tplId; renderTemplates(); return; }
    const act = e.target.closest('[data-tpl], [data-var]');
    if (!act) return;
    if (act.dataset.var) {
      const box = $('tplBody');
      if (!box) return;
      const start = box.selectionStart, end = box.selectionEnd;
      box.value = box.value.slice(0, start) + act.dataset.var + box.value.slice(end);
      box.focus();
      return;
    }
    if (act.dataset.tpl === 'close') { setTplOpen(false); return; }
    if (act.dataset.tpl === 'new') {
      view.tplId = '';
      upsertTemplate(draft.type === 'email' ? { name: 'New template', subject: '', html: '' } : { name: 'New template', body: '' });
      return;
    }
    if (act.dataset.tpl === 'delete') {
      if (draft.type === 'email') {
        const list = mail.templates();
        const i = list.findIndex(t => t.id === view.tplId);
        if (i >= 0) list.splice(i, 1);
        saveEmailTemplates();
      } else {
        const i = smsTemplates.findIndex(t => t.id === view.tplId);
        if (i >= 0) smsTemplates.splice(i, 1);
        saveSmsTemplates();
      }
      view.tplId = (templates()[0] || {}).id || '';
      renderTemplates();
      return;
    }
    if (act.dataset.tpl === 'save') {
      const name = $('tplName').value.trim() || 'Untitled';
      const body = $('tplBody').value;
      if (draft.type === 'email') upsertTemplate({ name, subject: $('tplSubject').value, html: body });
      else upsertTemplate({ name, body });
    }
  });

  // Any button that names a drawer opens or closes it. Any company name opens that lead.
  page.addEventListener('click', e => {
    if (e.target.closest('#campMoreMenu button')) more.open = false;
    const screen = e.target.closest('[data-camp-screen]');
    if (screen) {
      view.screen = screen.dataset.campScreen === 'overview' ? 'overview' : 'builder';
      render();
      if (view.screen === 'builder') {
        const current = $('campSteps').querySelector('[aria-current="step"]');
        (current || (!$('campName').hidden ? $('campName') : null))?.focus();
      }
      return;
    }
    const card = e.target.closest('[data-channel]');
    if (card) draft.type = card.dataset.channel;
    const b = e.target.closest('[data-drawer-open]'), lead = e.target.closest('[data-lead]');
    if (b) setDrawer(view.drawer === b.dataset.drawerOpen ? '' : b.dataset.drawerOpen);
    if (lead) openLead(Number(lead.dataset.lead));
  });

  // ── AUDIENCE EVENTS ──
  page.querySelector('.cp-filters').addEventListener('click', e => {
    const b = e.target.closest('[data-menu]');
    if (b) { if (view.menu === b.dataset.menu) closeMenu(true); else { closeMenu(false); openMenu(b); } }
  });
  $('campTouch').addEventListener('change', e => { draft.filters.touch = e.target.value; changed(); });
  $('campSearch').addEventListener('input', e => { draft.filters.search = e.target.value; changed(); });
  $('campCounts').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    view.list = b.dataset.view;
    renderStep();
  });
  $('campEmpty').addEventListener('click', e => {
    if (e.target.closest('[data-clear="all"]')) {
      draft.filters = { ...blankFilters(), reps: draft.filters.reps };
      save();
      render();
      $('campSearch').focus();
    }
  });

  // ── SETUP + REVIEW EVENTS ──
  function useChannel(el) {
    const card = el.closest('[data-channel]');
    if (card) draft.type = card.dataset.channel;
    return ch();
  }
  $('campBoard').addEventListener('click', e => {
    const c = useChannel(e.target);
    const b = e.target.closest('[data-act], [data-mode], [data-when]');
    if (!b) return;
    if (b.dataset.act === 'templates') { setTplOpen(true); return; }
    if (b.dataset.act === 'preview') { openPreview(); return; }
    if (b.dataset.act === 'start') { requestStart(); return; }
    if (b.dataset.mode) c.mode = b.dataset.mode;
    if (b.dataset.when) {
      draft.schedule.when = b.dataset.when;
      if (b.dataset.when === 'later' && !draft.schedule.at) draft.schedule.at = inputValue(Date.now() + 2 * 3600000).slice(0, 14) + '00';
    }
    changed();
  });
  $('campBoard').addEventListener('change', e => {
    const c = useChannel(e.target), el = e.target;
    if (el.dataset.s === 'template') c.template = el.value;
    else if (el.dataset.s === 'method') { c.method = el.value; if (el.value === 'single') c.senders = c.senders.slice(0, 1); }
    else if (el.dataset.s === 'at') draft.schedule.at = el.value;
    else return;
    changed();
  });

  $('campSetup').addEventListener('click', e => {
    const c = ch(), b = e.target.closest('[data-act], [data-mode], [data-when]');
    if (!b) return;
    if (b.dataset.act === 'preview') { openPreview(); return; }
    if (b.dataset.act === 'templates') { setTplOpen(true); return; }
    if (b.dataset.mode) c.mode = b.dataset.mode;
    if (b.dataset.when) {
      draft.schedule.when = b.dataset.when;
      if (b.dataset.when === 'later' && !draft.schedule.at) {
        draft.schedule.at = inputValue(Date.now() + 2 * 3600000).slice(0, 14) + '00';
      }
    }
    changed();
  });
  $('campSetup').addEventListener('change', e => {
    const el = e.target, c = ch();
    if (el.dataset.s === 'template') c.template = el.value;
    else if (el.dataset.s === 'method') { c.method = el.value; if (el.value === 'single') c.senders = c.senders.slice(0, 1); }
    else if (el.dataset.s === 'at') draft.schedule.at = el.value;
    else return;
    changed();
    if (view.drawer === 'senders') renderDrawer();
  });
  $('campSetup').addEventListener('input', e => {
    if (e.target.dataset.s === 'notes') { draft.notes = e.target.value; save(); }
  });
  $('campReview').addEventListener('click', e => {
    if (!e.target.closest('[data-act="dry"]')) return;
    dryRun();
    renderStep();
  });

  // ── LIVE + RESULTS EVENTS ──
  $('campRunTop').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act, r = shownRecord(), control = mine() && fullView(r);
    if (act === 'pause' && control) engine.pause();
    if (act === 'resume' && control) engine.resume();
    if (act === 'clone') cloneRecord(r);
    if (act === 'stop' && control) {
      const scheduled = r.status === 'scheduled';
      ask({ title: scheduled ? 'Cancel this campaign?' : 'Stop this campaign?', text: 'Messages not sent yet are cancelled. Everything already sent, and its history, stays.',
        ok: scheduled ? 'Cancel campaign' : 'Stop campaign', danger: true }).then(yes => { if (yes) (engine ? engine.stop() : api.setStatus('stopped')); });
    }
  });
  $('campFeedFilters').addEventListener('click', e => {
    const b = e.target.closest('[data-feed]');
    if (!b) return;
    view.feed = b.dataset.feed;
    keepFocus(() => renderFeed(viewOf(shownRecord())));
  });
  $('campFeedSearch').addEventListener('input', e => { view.feedQuery = e.target.value; renderFeed(viewOf(shownRecord())); });
  $('campAutoScroll').addEventListener('change', () => renderFeed(viewOf(shownRecord())));

  if (isChanged()) $('campSaved').textContent = 'Draft saved';
  // After a reload, a campaign that was running or scheduled carries on where the sending service left it —
  // in this tab only if no other open tab is already driving it.
  ensureEngineRunning();

  return {
    render,
    // For the Activity Log: every campaign record, and a way to open one's Live or Results.
    records: () => records,
    openRecord(id) { showPage('camp'); openRecord(id); },
    // Escape closes the top-most open part of this page. Windows close themselves.
    escape() {
      if (page.hidden) return false;
      if (dialog.open) return true;
      if (view.menu) { closeMenu(true); return true; }
      if (view.drawer) { setDrawer(''); return true; }
      return false;
    }
  };
})();
