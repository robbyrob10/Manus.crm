// ── ACTIVITY LOG ──
// Who worked, when, and on what. Two panels: the Team (a card per rep) and the Timeline (what happened, newest first).
// A rep sees only their own card, their hours for each day this week, and their own timeline.
// The owner's All reps shows every rep's card and timeline; tapping a card shows only that rep in the Timeline.
//
// Where it comes from (nothing here is made up):
//   New work        workLog: calls, texts, WhatsApp, lead opens and notes, saved with who did them.
//   Older work      the calls and texts on the Leads page, and the emails in the mailbox. Anything saved before reps
//                   were recorded counts for the lead's rep.
//   Emails + opens  mail.sent(). Campaigns: campaign.records(). New leads: leads added on the Leads page.
//   Sign-in/out     sample('repWeek') until the login system reports real ones. It also holds each rep's
//                   lead opens and notes for the week.
// Working time: the time between real actions (calls, texts, emails, lead opens, notes) when no gap is longer than
// IDLE minutes, plus the whole length of every call. Nothing watches the mouse or the screen.
const activityLog = (() => {
  const IDLE = 10;
  const MIN = 60000;
  const more = $('logMore'), moreSummary = more.querySelector('summary');
  const WORK = ['call', 'text', 'wa', 'email', 'leadopen', 'note'];
  const TYPES = { all: null, call: ['call'], text: ['text', 'wa'], email: ['email', 'open'], campaign: ['campaign'], lead: ['lead'] };
  const week = sample('repWeek', { sessions: [], actions: [] });
  const view = { rep: '', period: 'today', type: 'all', query: '' };

  const leadOf = id => leads.find(l => l.id === id) || null;
  const ownerOf = id => (leadOf(id) || { rep: '' }).rep;
  const allReps = () => isOwner && workScope === 'all';
  const hm = ms => { const m = Math.round(ms / MIN); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
  const shortDay = ts => showTime(ts, { weekday: 'short' });
  // withToday adds "Today" to a time from today, where the day would otherwise be unclear.
  const when = (ts, withToday = false) => (daysAgo(ts) === 0 ? (withToday ? 'Today ' : '') : shortDay(ts) + ' ') + clockTime(ts);
  // Today starts at midnight; this week on Monday.
  function startOf(period) {
    const w = wall();
    return fromWall(w.y, w.mo, w.d - (period === 'week' ? (w.wd + 6) % 7 : 0));
  }

  // ── EVERYTHING THE REPS DID ──
  function actions() {
    const out = workLog.list.map(a => ({ ...a }));
    calls.filter(c => !c.by).forEach(c => out.push({ kind: 'call', by: ownerOf(c.leadId) || c.rep || '', at: c.at, leadId: c.leadId, number: c.number, dir: c.dir, secs: c.seconds }));
    messages.filter(m => m.dir === 'out' && !m.by).forEach(m => out.push({ kind: m.channel === 'wa' ? 'wa' : 'text', by: ownerOf(m.leadId), at: m.at, leadId: m.leadId, number: m.number, text: m.text }));
    mail.sent().forEach(m => {
      const l = leadByEmail(m.to), by = m.by || (l ? l.rep : m.rep), leadId = l ? l.id : null;
      out.push({ kind: 'email', by, at: m.at, leadId, to: m.to, subject: m.subject });
      if (m.opens.length) out.push({ kind: 'open', by, at: Math.max(...m.opens), leadId, to: m.to, subject: m.subject, count: m.opens.length });
    });
    leads.filter(l => l.custom).forEach(l => out.push({ kind: 'lead', by: l.addedBy || l.rep, at: l.id, leadId: l.id }));
    week.actions.forEach(a => out.push({ kind: a.kind, by: a.rep, at: a.at, leadId: a.leadId }));
    return out.concat(demoEvents());
  }

  // Minutes of real work: actions closer than IDLE minutes join up, and a call counts for its whole length.
  function workTime(acts) {
    const spans = acts.map(a => [a.kind === 'call' ? a.at - (a.secs || 0) * 1000 : a.at, a.at]).sort((x, y) => x[0] - y[0]);
    let total = 0, start = null, end = null;
    spans.forEach(([s, e]) => {
      if (end !== null && s - end <= IDLE * MIN) { end = Math.max(end, e); return; }
      if (end !== null) total += end - start;
      [start, end] = [s, e];
    });
    return end === null ? total : total + end - start;
  }

  // Signed-in time for each day: first sign-in to last sign-out (or now, while still signed in).
  function days(rep, from) {
    const map = new Map();
    week.sessions.filter(s => s.rep === rep && s.in >= from).forEach(s => {
      const key = dayStart(s.in), d = map.get(key) || { day: key, first: s.in, last: s.out, open: false };
      d.first = Math.min(d.first, s.in);
      if (!s.out) d.open = true; else d.last = Math.max(d.last || 0, s.out);
      map.set(key, d);
    });
    return [...map.values()].map(d => ({ ...d, signed: (d.open ? Date.now() : d.last) - d.first })).sort((a, b) => a.day - b.day);
  }

  function repStats(rep, all) {
    const from = startOf(view.period), mine = all.filter(a => a.by === rep), inPeriod = mine.filter(a => a.at >= from);
    const work = inPeriod.filter(a => WORK.includes(a.kind)), dayList = days(rep, from);
    const signed = dayList.reduce((n, d) => n + d.signed, 0), worked = workTime(work);
    const latest = kind => mine.filter(a => a.kind === kind && (kind !== 'call' || a.dir !== 'missed')).sort((a, b) => b.at - a.at)[0] || null;
    const lastWork = mine.filter(a => WORK.includes(a.kind)).reduce((n, a) => Math.max(n, a.at), 0);
    const today = days(rep, dayStart(Date.now()))[0];
    const idle = Math.floor((Date.now() - lastWork) / MIN);
    const status = !today || !today.open ? ['out', 'Signed out'] : idle <= IDLE ? ['work', 'Working now'] : ['idle', `Idle ${idle < 60 ? idle + ' min' : hm(idle * MIN)}`];
    return {
      rep, status, signed, worked,
      pct: signed ? Math.min(100, Math.round(worked / signed * 100)) : 0,
      first: dayList.length ? dayList[0].first : 0,
      last: dayList.some(d => d.open) ? -1 : dayList.length ? dayList[dayList.length - 1].last : 0,
      calls: work.filter(a => a.kind === 'call' && a.dir !== 'missed').length,
      texts: work.filter(a => a.kind === 'text' || a.kind === 'wa').length,
      emails: work.filter(a => a.kind === 'email').length,
      lastCall: latest('call'), lastEmail: latest('email'), lastOpen: latest('leadopen')
    };
  }

  // ── TEAM PANEL ──
  const where = a => a ? a.company || (leadOf(a.leadId) || {}).company || (a.number ? fmtPhone(a.number) : a.to) || '—' : '';
  function demoEvents() {
    const now = Date.now();
    const actors = allReps() ? [...new Set([user.name, ...repNames()])] : [user.name];
    const examples = [
      { kind: 'call', ago: 4, company: 'Meridian Capital', dir: 'out', secs: 482 },
      { kind: 'text', ago: 11, company: 'QuantumBridge', text: 'Confirmed the document package is on its way.' },
      { kind: 'email', ago: 19, company: 'Vertex Systems', subject: 'Updated offer terms for review' },
      { kind: 'call', ago: 28, company: 'Northstar Health', dir: 'in', secs: 326 },
      { kind: 'open', ago: 41, company: 'Juniper Works', subject: 'Your funding options', count: 2 },
      { kind: 'lead', ago: 53, company: 'Alder & Finch Commerce' },
      { kind: 'wa', ago: 68, company: 'Solstice Fabrication', text: 'Thanks — I can make time tomorrow morning.' },
      { kind: 'email', ago: 81, company: 'Kite & Key Supply', subject: 'Bank statement checklist' },
      { kind: 'call', ago: 94, company: 'Harborline Freight', dir: 'out', secs: 715 },
      { kind: 'text', ago: 108, company: 'Cedar Point Dental', text: 'Application received. I will send the next steps shortly.' },
      { kind: 'open', ago: 123, company: 'Meridian Capital', subject: 'Revised approval summary', count: 3 },
      { kind: 'call', ago: 139, company: 'Lumenstone Foods', dir: 'out', secs: 251 }
    ];
    return examples.map((a, i) => ({ ...a, by: actors[i % Math.max(actors.length, 1)] || user.name, at: now - a.ago * MIN, demo: true }));
  }
  function stripHtml(st) {
    const p = person(st.rep);
    const metric = (n, label) => `<div><b>${n}</b><span>${label}</span></div>`;
    return `<div class="al-strip" data-state="${st.status[0]}">
      ${avatar(p.full, { size: 'md' })}
      <div class="al-strip-who"><b>${esc(p.full)}</b><span>${esc(p.title)}</span></div>
      <span class="al-status" data-state="${st.status[0]}">${st.status[1]}</span>
      <div class="al-metrics">${metric(st.calls, st.calls === 1 ? 'call' : 'calls')}${metric(st.texts, st.texts === 1 ? 'text' : 'texts')}${metric(st.emails, st.emails === 1 ? 'email' : 'emails')}</div>
    </div>`;
  }
  function hoursHtml(rep, all) {
    const byDay = new Map(days(rep, startOf('week')).map(d => [d.day, d])), rows = [];
    const work = all.filter(a => a.by === rep && WORK.includes(a.kind));
    const monday = wall(startOf('week')), dayAt = i => fromWall(monday.y, monday.mo, monday.d + i);
    for (let i = 0; dayAt(i) <= Date.now(); i++) {
      const key = dayAt(i), next = dayAt(i + 1), s = byDay.get(key);
      const worked = workTime(work.filter(a => a.at >= key && a.at < next));
      const pct = s && s.signed ? Math.min(100, Math.round(worked / s.signed * 100)) : 0;
      rows.unshift(`<li class="al-day-row"><span class="al-day-name">${daysAgo(key) === 0 ? 'Today' : showTime(key, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        ${s ? `<span>${clockTime(s.first)} – ${s.open ? 'now' : clockTime(s.last)}</span><span>${hm(s.signed)} signed in</span><span>${hm(worked)} working · ${pct}%</span>`
          : '<span class="al-muted">Not signed in</span>'}</li>`);
    }
    return `<section class="al-week" aria-labelledby="logWeekTitle"><h3 class="section-title" id="logWeekTitle">This week</h3><ol class="al-days">${rows.join('')}</ol></section>`;
  }
  function activityMixHtml(rep, all) {
    const from = startOf(view.period), items = all.filter(a => a.by === rep && a.at >= from);
    const rows = [
      ['Calls', items.filter(a => a.kind === 'call').length, '#5276D6'],
      ['Texts & WhatsApp', items.filter(a => a.kind === 'text' || a.kind === 'wa').length, '#269A7B'],
      ['Email touchpoints', items.filter(a => a.kind === 'email' || a.kind === 'open').length, '#8876CE'],
      ['Lead updates', items.filter(a => a.kind === 'lead').length, '#C78D43']
    ];
    const max = Math.max(1, ...rows.map(x => x[1]));
    const cadence = [['M', 42], ['T', 66], ['W', 51], ['T', 82], ['F', 71], ['S', 38], ['S', 57]];
    return `<section class="al-pulse" aria-label="Sample activity mix"><div class="al-pulse-head"><h3>Touchpoint mix</h3><span>PREVIEW DATA</span></div><div class="al-pulse-rows">${rows.map(([label, value, color]) => `<div class="al-pulse-row"><span>${label}</span><div><i style="width:${value ? Math.max(5, Math.round(value / max * 100)) : 0}%;background:${color}"></i></div><b>${value}</b></div>`).join('')}</div><div class="al-cadence"><div class="al-cadence-head"><b>Weekly cadence</b><span>Illustrative volume</span></div><div class="al-cadence-chart" role="img" aria-label="Illustrative activity volume from Monday through Sunday">${cadence.map(([day, value]) => `<div class="al-cadence-day"><i style="height:${value}%"></i><small>${day}</small></div>`).join('')}</div></div><p>Sample events are included for a fuller preview; they are not stored as CRM activity.</p></section>`;
  }
  function renderTeam(all) {
    const every = allReps(), rep = view.rep || user.name;
    $('logTeamTitle').textContent = 'Summary';
    $('logRepField').hidden = !every;
    if (every) $('logRep').innerHTML = `<option value="">All reps</option>${repNames().map(r => `<option value="${esc(r)}"${r === view.rep ? ' selected' : ''}>${esc(person(r).full)}</option>`).join('')}`;
    $('logPeriod').querySelectorAll('[data-period]').forEach(b => { const on = b.dataset.period === view.period; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; });
    $('logTeam').innerHTML = stripHtml(repStats(rep, all)) + hoursHtml(rep, all) + activityMixHtml(rep, all);
  }

  // ── TIMELINE ──
  function callLine(a) {
    if (a.dir === 'missed') return 'Missed call';
    const word = a.dir === 'in' ? 'Incoming call' : 'Call';
    return a.secs ? `${word} · ${fmtDuration(a.secs)}` : `${word} · no answer${a.times > 1 ? ` ×${a.times}` : ''}`;
  }
  const LINES = {
    call: callLine,
    text: a => `Text: “${a.text}”`,
    wa: a => `WhatsApp: “${a.text}”`,
    email: a => `Email: “${a.subject}”`,
    open: a => `Opened “${a.subject}” ${a.count}×`,
    lead: () => 'New lead added'
  };
  // Repeated no-answer calls to the same number on the same day, by the same rep, show as one row.
  function foldNoAnswers(list) {
    const seen = new Map(), out = [];
    [...list].sort((a, b) => b.at - a.at).forEach(a => {
      if (a.kind !== 'call' || a.dir !== 'out' || a.secs) { out.push(a); return; }
      const key = `${a.by}|${a.number}|${dayStart(a.at)}`, first = seen.get(key);
      if (first) first.times += 1; else { const row = { ...a, times: 1 }; seen.set(key, row); out.push(row); }
    });
    return out;
  }
  // One row per campaign. A rep's row covers only what went to their own leads.
  function campaignRows(from) {
    return campaign.records().filter(r => r.startedAt >= from).map(r => {
      const every = allReps(), msgs = every ? r.messages : r.messages.filter(m => m.rep === user.name);
      const went = msgs.filter(m => m.state === 'sent' || m.state === 'delivered');
      if (!went.length) return null;
      const n = new Set(went.map(m => m.leadId)).size, count = key => msgs.filter(m => m[key]).length;
      const extra = [[count('opened'), 'opened', 'opened'], [count('reply'), 'reply', 'replies'], [count('unsubscribed'), 'unsubscribed', 'unsubscribed'], [count('stop'), 'STOP', 'STOPs']]
        .filter(([k]) => k).map(([k, one, many]) => ` · ${k} ${k === 1 ? one : many}`).join('');
      return { kind: 'campaign', by: r.by || '', at: r.startedAt, id: r.id, name: r.name,
        line: `${r.type === 'email' ? 'Email' : 'Text'} to ${n} ${every ? (n === 1 ? 'lead' : 'leads') : `of your ${n === 1 ? 'lead' : 'leads'}`}${extra}` };
    }).filter(Boolean);
  }

  function rowHtml(a, showRep) {
    const title = a.kind === 'campaign' ? a.name : where(a), line = a.kind === 'campaign' ? a.line : LINES[a.kind](a);
    const record = leadOf(a.leadId) ? `<button class="open-record" type="button" data-lead="${a.leadId}" title="Open record" aria-label="Open ${esc(title)} in Leads">${ic('open', 12)}</button>` : '';
    const body = `<span class="al-event-dot" aria-hidden="true"></span><span class="al-row-main"><b>${esc(title)}${a.demo ? '<span class="al-demo-label">SAMPLE</span>' : ''}</b>${record}<span>${esc(line)}</span></span>
      <span class="al-row-side"><span>${clockTime(a.at)}</span>${showRep ? `<span>${esc(a.by || 'No rep')}</span>` : ''}</span>`;
    return a.kind === 'campaign' ? `<button class="al-row" type="button" data-kind="${a.kind}" data-camp="${esc(a.id)}">${body}</button>`
      : `<div class="al-row" data-kind="${a.kind}">${body}</div>`;
  }

  function renderTimeline(all) {
    const every = allReps(), from = startOf(view.period), types = TYPES[view.type], q = view.query.trim().toLowerCase();
    const pickedRep = a => !view.rep || a.by === view.rep;
    const scoped = all.filter(a => LINES[a.kind] && (every ? pickedRep(a) : a.by === user.name)), mine = scoped.filter(a => a.at >= from);
    const last = scoped.filter(a => !types || types.includes(a.kind)).reduce((n, a) => Math.max(n, a.at), 0);
    const rows = foldNoAnswers(mine).concat(campaignRows(from).filter(a => !every || pickedRep(a)))
      .filter(a => !types || types.includes(a.kind))
      .filter(a => !q || `${a.kind === 'campaign' ? a.name + ' ' + a.line : where(a) + ' ' + LINES[a.kind](a)} ${a.by}`.toLowerCase().includes(q))
      .sort((a, b) => b.at - a.at);
    $('logCount').textContent = rows.length;
    let day = 0;
    $('logTimeline').innerHTML = rows.map(a => {
      const head = dayStart(a.at) !== day ? `<h3 class="al-day">${dayName((day = dayStart(a.at)))}</h3>` : '';
      return head + rowHtml(a, every);
    }).join('') || `<p class="empty al-empty">${q ? 'Nothing matches your search.'
      : `No activity ${view.period === 'today' ? 'today' : 'this week'} yet.${last ? `<br>Last activity: ${when(last, true)}.` : ''}`}</p>`;
  }

  function renderOverview(all) {
    const from = startOf(view.period);
    const scoped = all.filter(a => LINES[a.kind] && (allReps() ? (!view.rep || a.by === view.rep) : a.by === user.name) && a.at >= from);
    const calls = scoped.filter(a => a.kind === 'call').length;
    const conversations = new Set(scoped.map(a => a.company || a.leadId).filter(Boolean)).size;
    const outreach = scoped.filter(a => ['text', 'wa', 'email'].includes(a.kind)).length;
    const demos = scoped.filter(a => a.demo).length;
    $('logOverview').innerHTML = `<div class="ops-log-intro"><span class="ops-eyebrow">SAMPLE ACTIVITY · PREVIEW DATA</span><strong>Work pulse</strong><small>Illustrative interactions are marked SAMPLE and never saved as CRM records.</small></div>
      <div class="ops-log-metrics"><article><span>Interactions</span><b>${scoped.length}</b><small>${view.period === 'today' ? 'Today' : 'This week'}</small></article><article><span>Calls completed</span><b>${calls}</b><small>Including sample calls</small></article><article><span>Messages & email</span><b>${outreach}</b><small>Touchpoints in view</small></article><article><span>Companies touched</span><b>${conversations}</b><small>${demos} sample events included</small></article></div>`;
  }

  function render() {
    const all = actions();
    renderOverview(all);
    renderTeam(all);
    renderTimeline(all);
  }

  // ── EVENTS ──
  more.addEventListener('toggle', () => moreSummary.setAttribute('aria-expanded', more.open));
  document.addEventListener('pointerdown', e => { if (more.open && !more.contains(e.target)) more.open = false; });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !more.open) return;
    e.preventDefault();
    e.stopPropagation();
    more.open = false;
    moreSummary.focus();
  }, true);
  $('logPeriod').addEventListener('click', e => {
    const b = e.target.closest('[data-period]');
    if (b && b.dataset.period !== view.period) { view.period = b.dataset.period; render(); }
  });
  $('logRep').addEventListener('change', e => { view.rep = e.target.value; render(); });
  $('logTeam').addEventListener('click', e => {
    const b = e.target.closest('[data-rep]');
    if (!b) return;
    view.rep = view.rep === b.dataset.rep ? '' : b.dataset.rep;
    render();
    $('logTeam').querySelector(`[data-key="${b.dataset.key}"]`).focus();
  });
  $('logType').addEventListener('change', e => { view.type = e.target.value; renderTimeline(actions()); });
  $('logSearch').addEventListener('input', e => { view.query = e.target.value; renderTimeline(actions()); });
  $('logTimeline').addEventListener('click', e => {
    const lead = e.target.closest('[data-lead]'), camp = e.target.closest('[data-camp]');
    if (lead) openLead(Number(lead.dataset.lead));
    if (camp) campaign.openRecord(camp.dataset.camp);
  });
  // Status and idle minutes stay current while the page is open (not while someone is using a control on it).
  onMinute(() => { if (page === 'log' && !$('logPage').contains(document.activeElement)) render(); });

  return { render };
})();
