// ── GLOBAL SEARCH ──
// The top bar's search, on every page. It looks through leads (company, legal name, DBA, contact, phone numbers and
// emails), email conversations, and texts and WhatsApp, and lists up to 5 of each under the box.
// ↑ ↓ move through them, Enter or a click opens one, Esc closes the list. On the Leads page the lead list also narrows
// to what is typed (leads.js).
(() => {
  const input = $('globalSearch'), box = $('searchResults'), LIMIT = 5;
  let items = [], active = -1, timer = 0;

  const wordsOf = q => q.toLowerCase().split(/\s+/).filter(Boolean);
  function findLeads(q) {
    const words = wordsOf(q), digits = digitsOf(q);
    return leads.filter(l => canSee(l.rep) || isOwner).filter(l => {
      const text = [l.company, l.legal, l.dba, fullName(l), ...l.emails].join(' ').toLowerCase();
      return words.every(w => text.includes(w)) || (digits.length >= 3 && l.phones.some(p => digitsOf(p.num).includes(digits)));
    }).slice(0, LIMIT).map(l => ({
      icon: 'user', title: l.company, sub: fullName(l) + (l.rep && l.rep !== user.name ? ` · ${l.rep}` : ''), when: '',
      open: () => openLead(l.id)
    }));
  }
  function findMessages(q) {
    const words = wordsOf(q), seen = new Set();
    return shownMessages().filter(m => { const text = m.text.toLowerCase(); return words.every(w => text.includes(w)); })
      .sort((a, b) => b.at - a.at)
      .filter(m => { const key = m.channel + ':' + m.number; if (seen.has(key)) return false; seen.add(key); return true; })
      .slice(0, LIMIT).map(m => ({
        icon: m.channel === 'wa' ? 'wa' : 'sms', title: nameOf(m.leadId, m.number), sub: m.text, when: timeAgo(m.at, true),
        open: () => {
          showPage('leads');
          if (m.leadId && m.leadId !== selectedId) openLead(m.leadId);
          openThread(m.channel, m.number);
        }
      }));
  }
  function findEmails(q) {
    return mail.find(q, LIMIT).map(t => ({
      icon: 'mail', title: t.subject, sub: t.who, when: timeAgo(t.at, true),
      open: () => { showPage('mail'); mail.openThread(t.id); }
    }));
  }

  function close() {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    items = [];
    active = -1;
  }
  function mark(i) {
    active = i;
    box.querySelectorAll('.gs-item').forEach((b, n) => b.setAttribute('aria-selected', n === i));
    if (i >= 0) { input.setAttribute('aria-activedescendant', 'gs' + i); $('gs' + i).scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function show() {
    const q = input.value.trim();
    if (!q) { close(); return; }
    const groups = [['Leads', findLeads(q)], ['Emails', findEmails(q)], ['Messages', findMessages(q)]].filter(([, list]) => list.length);
    items = groups.flatMap(([, list]) => list);
    let n = 0;
    box.innerHTML = groups.length ? groups.map(([name, list]) => `<div class="gs-head" role="presentation">${name}</div>${list.map(it => `
      <button class="gs-item" type="button" role="option" id="gs${n}" data-i="${n++}" aria-selected="false" tabindex="-1">${ic(it.icon, 14)}
        <span class="gs-text"><span class="gs-title">${esc(it.title)}</span><span class="gs-sub">${esc(it.sub)}</span></span>
        ${it.when ? `<span class="gs-when">${esc(it.when)}</span>` : ''}</button>`).join('')}`).join('')
      : `<div class="gs-none">No matches for “${esc(q)}”.</div>`;
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    mark(items.length ? 0 : -1);
  }
  function pick(i) {
    const it = items[i];
    if (!it) return;
    close();
    input.blur();
    it.open();
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 120); });
  input.addEventListener('focus', () => { if (input.value.trim()) show(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !box.hidden) { e.stopPropagation(); close(); return; }
    if (box.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mark(clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
  });
  box.addEventListener('mousedown', e => e.preventDefault());
  box.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) pick(Number(b.dataset.i)); });
  document.addEventListener('pointerdown', e => { if (!box.hidden && !e.target.closest('.topbar-search')) close(); });
})();
