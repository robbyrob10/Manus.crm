// ── FOLLOW-UP REMINDERS ──
// A reminder is { id, leadId, type, text, at, done, alerted }. type sets the icon: call, meet, or remind (one made here).
// All of them are kept in this browser (nv.reminders). The first time the CRM opens, the sample ones are copied in.
// A reminder shows under Coming up in the lead's Activity, as a clock in the lead list when it is due today, and on the
// Dashboard. When it comes due it becomes an alert (bell, banner) with Done and Snooze. Reminders only go off while the
// CRM is open. Whose it is follows the lead: each rep sees the reminders on their own leads.
const reminders = (() => {
  const list = store.read('nv.reminders', null) ?? sample('reminders', []).map((r, i) => ({ id: 'rs' + i, done: false, alerted: false, ...r }));
  const save = () => store.write('nv.reminders', list);
  const leadOf = r => leads.find(l => l.id === r.leadId);
  const shown = () => list.filter(r => !r.done && leadOf(r) && canSee(leadOf(r).rep)).sort((a, b) => a.at - b.at);
  const find = id => list.find(r => r.id === id);
  // Reminder times are whole minutes, so they go off with the minute clock (onMinute).
  const toMinute = ts => Math.ceil(ts / 60000) * 60000;
  const endOfToday = () => { const w = wall(); return fromWall(w.y, w.mo, w.d + 1); };
  const at9 = days => { const w = wall(); return fromWall(w.y, w.mo, w.d + days, 9); };
  const whenText = r => (r.at <= Date.now() ? 'Overdue · ' : '') + dayTime(r.at);

  // ── ALERTS ──
  // Each due reminder is one alert. Its id carries the due time, so a snoozed reminder comes back as a new, unread alert.
  const alertOf = r => ({ id: `rem-${r.id}-${r.at}`, kind: 'remind', ref: r.id, leadId: r.leadId, text: r.text, at: r.at });
  const alerts = () => shown().filter(r => r.alerted).map(alertOf);
  // Puts the alert list back in step after a reminder is done, undone or snoozed.
  function syncAlerts() {
    notifications = notifications.filter(n => n.kind !== 'remind').concat(alerts()).sort((a, b) => b.at - a.at);
    renderNotifs();
  }
  function refresh() {
    renderLeads();
    if (currentLead()) renderFeed();
    if (page === 'dash') dashboard.render();
  }
  // Every minute (and once the CRM has loaded): reminders that just came due go off.
  function check() {
    const due = list.filter(r => !r.done && !r.alerted && r.at <= Date.now());
    if (!due.length) return;
    due.forEach(r => { r.alerted = true; });
    save();
    due.forEach(r => { if (leadOf(r)) notify(alertOf(r)); });
    refresh();
  }

  // ── DONE AND SNOOZE ──
  function done(id) {
    const r = find(id);
    r.done = true;
    save();
    syncAlerts();
    refresh();
    toast('Reminder done.', [{ label: 'Undo', run: () => { r.done = false; save(); syncAlerts(); refresh(); } }]);
  }
  function snooze(id, at) {
    const r = find(id);
    Object.assign(r, { at: toMinute(at), alerted: false });
    save();
    syncAlerts();
    refresh();
    toast(`Snoozed until ${dayTime(r.at)}.`);
  }
  function snoozeMenu(id, anchor) {
    openPop(anchor, [
      { label: 'In 10 minutes', run: () => snooze(id, Date.now() + 10 * 60000) },
      { label: 'In 1 hour', run: () => snooze(id, Date.now() + 3600000) },
      { label: 'Tomorrow 9:00 AM', run: () => snooze(id, at9(1)) }
    ], { list: true });
  }

  // ── ADD A REMINDER ──
  const box = $('remindBox'), form = $('remindForm');
  const PICKS = [['In 1 hour', () => Date.now() + 3600000], ['Tomorrow 9 AM', () => at9(1)], ['In 3 days', () => at9(3)], ['Next week', () => at9(7)]];
  let forLead = null;
  $('remindPicks').innerHTML = PICKS.map(([label], i) => `<button class="btn" type="button" data-pick-at="${i}">${label}</button>`).join('');
  function openAdd(l) {
    forLead = l.id;
    form.reset();
    $('remindTitle').textContent = `Remind me · ${l.company}`;
    $('remindAt').value = inputValue(toMinute(PICKS[1][1]()));
    $('remindError').textContent = '';
    box.showModal();
    $('remindText').focus();
  }
  $('remindPicks').addEventListener('click', e => {
    const b = e.target.closest('[data-pick-at]');
    if (b) $('remindAt').value = inputValue(toMinute(PICKS[b.dataset.pickAt][1]()));
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const at = fromInput($('remindAt').value);
    if (!(at > Date.now())) { $('remindError').textContent = 'Pick a time that is still to come.'; return; }
    list.push({ id: 'r' + Date.now().toString(36), leadId: forLead, type: 'remind', text: $('remindText').value.trim() || 'Follow up', at, done: false, alerted: false });
    save();
    box.close();
    refresh();
    toast(`Reminder set for ${dayTime(at)}.`);
  });
  $('remindCancel').addEventListener('click', () => box.close());
  box.addEventListener('mousedown', e => { if (e.target === box) box.close(); });
  // Keys pressed in the window stay in it, so page shortcuts never fire behind it.
  box.addEventListener('keydown', e => e.stopPropagation());

  // Coming up (Company Info › Activity): Remind me, and Done on each reminder.
  $('detail').addEventListener('click', e => {
    if (e.target.closest('[data-remind-add]')) { openAdd(currentLead()); return; }
    const b = e.target.closest('[data-remind-done]');
    if (b) done(b.dataset.remindDone);
  });

  // ── WHAT THE PAGES SHOW ──
  // Coming up in a lead's Activity: soonest first, overdue in red.
  const feedHtml = leadId => shown().filter(r => r.leadId === leadId).map(r => `
    <div class="feed-item">${kindIcon(r.type)}<div class="feed-main"><div class="feed-text">${esc(r.text)}</div><div class="feed-sub${r.at <= Date.now() ? ' overdue' : ''}">${whenText(r)}</div></div>
      <button class="remind-done" type="button" data-remind-done="${r.id}" title="Done" aria-label="Mark “${esc(r.text)}” done">${ic('check', 12)}</button></div>`).join('');
  // The lead list's clock: the lead has a reminder due today (red once overdue).
  function mark(leadId) {
    const r = shown().find(x => x.leadId === leadId && x.at < endOfToday());
    return r ? `<span class="lead-remind${r.at <= Date.now() ? ' overdue' : ''}" title="${esc(`${r.text} · ${whenText(r)}`)}" role="img" aria-label="Reminder ${esc(whenText(r))}">${ic('clock', 11)}</span>` : '';
  }
  // The Dashboard's Follow-ups due: the signed-in rep's own reminders due by the end of today.
  const dueToday = () => shown().filter(r => leadOf(r).rep === user.name && r.at < endOfToday());

  onMinute(check);
  mail.ready.then(check);
  return { alerts, done, snoozeMenu, feedHtml, mark, dueToday, whenText, leadOf };
})();
