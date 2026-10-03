// Dashboard: a presentation-only sample snapshot layered over the existing CRM records.
// The demo figures below are never written to storage. Real lead links continue to open the existing records.
const dashboard = (() => {
  const fallbackDeals = [
    { company: 'Northstar Health', contact: 'Avery Wells', stage: 'Offer structuring', value: 318000, age: '12 min ago' },
    { company: 'Alder & Finch Commerce', contact: 'Jordan Lee', stage: 'Underwriting', value: 275000, age: '48 min ago' },
    { company: 'Juniper Works', contact: 'Maya Chen', stage: 'Terms sent', value: 192000, age: '2 hours ago' },
    { company: 'Kite & Key Supply', contact: 'Riley Brooks', stage: 'Qualified', value: 146000, age: '3 hours ago' },
    { company: 'Solstice Fabrication', contact: 'Drew Park', stage: 'Initial review', value: 98000, age: '5 hours ago' }
  ];
  const stageData = [
    ['Qualified', 34, 56, '#5276D6'],
    ['Underwriting', 26, 42, '#4B91C1'],
    ['Offer sent', 18, 30, '#36A58A'],
    ['Contracting', 13, 21, '#8D7BD2'],
    ['Funded', 9, 15, '#D49A54']
  ];
  const greeting = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  };
  const spark = (values, tone = 'blue') => {
    const max = Math.max(...values), min = Math.min(...values), span = max - min || 1;
    const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${27 - ((v - min) / span) * 21}`).join(' ');
    return `<svg class="ops-spark ${tone}" viewBox="0 0 100 32" aria-hidden="true"><polyline points="${points}"/></svg>`;
  };
  function dealRows() {
    const actual = [...leads].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 5);
    return fallbackDeals.map((sample, i) => {
      const lead = actual[i];
      return lead ? { ...sample, lead, company: lead.company, contact: fullName(lead) || sample.contact, value: lead.value || sample.value } : sample;
    });
  }
  function render() {
    const stamp = showTime(Date.now(), { weekday: 'long', month: 'long', day: 'numeric' });
    $('dbHello').innerHTML = `<span class="ops-greeting">${greeting()}, ${esc(user.name)}</span><span class="ops-sample-flag">DEMO DATA</span>`;
    $('dbDate').textContent = `${stamp} · sample portfolio snapshot`;
    const kpis = [
      { label: 'Open pipeline', value: '$2.86M', delta: '+18.2%', note: 'vs. prior month', tone: 'blue', values: [5, 7, 6, 10, 9, 13, 16] },
      { label: 'Qualified deals', value: '42', delta: '+12.5%', note: '8 added this week', tone: 'teal', values: [4, 5, 5, 8, 7, 10, 13] },
      { label: 'Approval volume', value: '$684K', delta: '+9.4%', note: '6 offers in review', tone: 'violet', values: [4, 6, 5, 7, 8, 8, 11] },
      { label: 'Contact to offer', value: '31.8%', delta: '+3.1 pts', note: 'target 30%', tone: 'amber', values: [4, 4, 6, 5, 8, 9, 12] }
    ];
    $('dbStats').innerHTML = kpis.map(k => `<article class="ops-kpi ${k.tone}">
      <div class="ops-kpi-top"><span>${k.label}</span><span class="ops-kpi-mark" aria-hidden="true"></span></div>
      <div class="ops-kpi-value">${k.value}</div>
      <div class="ops-kpi-bottom"><span class="ops-kpi-delta">${k.delta}</span><span>${k.note}</span>${spark(k.values, k.tone)}</div>
    </article>`).join('');

    const deals = dealRows();
    const opportunityHtml = deals.map((d, i) => {
      const name = d.lead
        ? `<button class="ops-company-link" type="button" data-lead="${d.lead.id}" aria-label="Open ${esc(d.company)} in Leads">${esc(d.company)}</button>`
        : `<span class="ops-company-name">${esc(d.company)}</span>`;
      const stage = d.lead ? ['Underwriting', 'Terms sent', 'Qualified', 'Offer sent', 'Review'][i % 5] : d.stage;
      return `<div class="ops-deal-row">
        <div class="ops-deal-primary"><span class="ops-rank">0${i + 1}</span><div>${name}<small>${esc(d.contact)}</small></div></div>
        <span class="ops-stage-text" data-stage="${i % 5}">${stage}</span>
        <b class="ops-deal-value">${money(d.value)}</b>
        <span class="ops-deal-age">${d.age}</span>
      </div>`;
    }).join('');

    const reps = [...new Set([user.name, ...repNames()])];
    ['Maya Chen', 'David Ruiz', 'Jordan Lee', 'Taylor Nguyen'].forEach(n => { if (reps.length < 4 && !reps.includes(n)) reps.push(n); });
    const team = reps.slice(0, 4).map((name, i) => {
      const progress = [86, 73, 64, 51][i];
      return `<div class="ops-team-row"><div class="ops-person"><span class="ops-avatar" aria-hidden="true">${esc(name.split(/\s+/).map(p => p[0]).slice(0, 2).join(''))}</span><span><b>${esc(name)}</b><small>${['Portfolio lead', 'Senior rep', 'Account executive', 'Account executive'][i]}</small></span></div><div class="ops-target"><span><b>${[18, 15, 12, 9][i]}</b> / ${[21, 18, 17, 16][i]} target</span><span class="ops-progress"><i style="width:${progress}%"></i></span></div><strong>${progress}%</strong></div>`;
    }).join('');

    $('dbGrid').innerHTML = `
      <section class="ops-panel ops-stage-panel" aria-label="Sample portfolio by stage">
        <header class="ops-panel-head"><div><span class="ops-eyebrow">CURRENT MIX</span><h3>Portfolio by stage</h3></div><span class="ops-inline-total">124 <small>deals</small></span></header>
        <div class="ops-stage-list">${stageData.map(([label, pct, count, color]) => `<div class="ops-stage-row"><div class="ops-stage-meta"><span>${label}</span><b>${count}<small> deals</small></b></div><div class="ops-stage-track"><i style="width:${pct}%;background:${color}"></i></div><span class="ops-stage-pct">${pct}%</span></div>`).join('')}</div>
        <div class="ops-stage-foot"><span>Weighted pipeline</span><b>$1.94M</b></div>
      </section>
      <section class="ops-panel ops-opportunities" aria-label="Sample priority opportunities">
        <header class="ops-panel-head"><div><span class="ops-eyebrow">NEXT BEST ACTION</span><h3>Priority opportunities</h3></div><span class="ops-panel-note">Sorted by estimated value</span></header>
        <div class="ops-deal-table"><div class="ops-deal-head"><span>Company / contact</span><span>Stage</span><span>Requested</span><span>Activity</span></div>${opportunityHtml}</div>
      </section>
      <section class="ops-panel ops-team-panel" aria-label="Sample team performance">
        <header class="ops-panel-head"><div><span class="ops-eyebrow">SAMPLE SCORECARD</span><h3>Team pace</h3></div><span class="ops-panel-note">October goal</span></header>
        <div class="ops-team-list">${team}</div>
      </section>
      <section class="ops-panel ops-activity-panel" aria-label="Sample recent activity">
        <header class="ops-panel-head"><div><span class="ops-eyebrow">RECENT TOUCHPOINTS</span><h3>Activity stream</h3></div><span class="ops-live-mark"><i></i> Preview</span></header>
        <div class="ops-activity-list">
          <div class="ops-activity-row"><span class="ops-activity-icon blue">↗</span><span><b>Terms sent</b><small>Meridian Capital · James Liao</small></span><time>9 min</time></div>
          <div class="ops-activity-row"><span class="ops-activity-icon teal">✓</span><span><b>Documents received</b><small>QuantumBridge · David Ruiz</small></span><time>32 min</time></div>
          <div class="ops-activity-row"><span class="ops-activity-icon violet">✉</span><span><b>Reply received</b><small>Vertex Systems · Nathan Kim</small></span><time>1 hr</time></div>
          <div class="ops-activity-row"><span class="ops-activity-icon amber">＋</span><span><b>New application</b><small>Northstar Health · Avery Wells</small></span><time>2 hr</time></div>
        </div>
      </section>`;
  }

  $('dbGrid').addEventListener('click', e => {
    const b = e.target.closest('[data-lead]');
    if (b) openLead(Number(b.dataset.lead));
  });
  return { render };
})();
