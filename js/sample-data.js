// ── SAMPLE DATA ──
// Made-up content so every page has something to show before real data is connected. Nothing here is real.
// To remove it: delete this file and its <script> line in index.html.
// The Scanner page runs without it. The Leads, Email and Campaign pages still need it until they are connected to real data;
// without it the Campaign page has no senders and no sending service, and says so.
// It uses ago(), so it loads right after shared.js.
window.SAMPLE_DATA = {
  // ── TEAM ──
  // The reps. name matches each lead's rep; full name and title show in the sidebar and on the Activity Log.
  team: [
    { name: 'Marcus', full: 'Marcus Webb', title: 'Senior AE' },
    { name: 'Sam', full: 'Sam', title: 'Owner' },
    { name: 'Sarah', full: 'Sarah Lane', title: 'Account Executive' },
    { name: 'Mike', full: 'Mike Ortiz', title: 'Account Executive' }
  ],
  // ── ACTIVITY LOG ──
  // Each rep's sign-ins and sign-outs, and the leads they opened and notes they wrote, for the last 7 days.
  // Real sign-in and sign-out come from the login system later; real lead opens and notes are saved as reps work.
  // sessions: { rep, in, out } (out 0 = still signed in). actions: { rep, kind: 'leadopen' or 'note', leadId, at }.
  repWeek: (() => {
    const HOUR = 3600000, MIN = 60000, now = Date.now(), midnight = dayStart();
    // [rep, their leads, usual start and end hour, minutes since their last action today (-1 = signed out for the day)]
    const reps = [['Marcus', [1, 5, 9], 8.6, 17.4, 2], ['Sam', [2, 6, 10], 8.2, 18, 24], ['Sarah', [4, 8, 12], 9, 17.6, 4], ['Mike', [3, 7, 11], 8.8, 16.5, -1]];
    let seed = 7;
    const rand = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    const sessions = [], actions = [];
    reps.forEach(([rep, ids, start, end, idle]) => {
      for (let d = 6; d >= 0; d--) {
        const base = midnight - d * 24 * HOUR;
        const signIn = base + (start + rand() * 0.4) * HOUR, dayEnd = base + (end + rand() * 0.5) * HOUR;
        const today = d === 0, stillIn = today && idle >= 0;
        const signOut = !today ? dayEnd : stillIn ? 0 : Math.min(dayEnd, now - 20 * MIN);
        const lastAction = stillIn ? now - idle * MIN : signOut - 5 * MIN;
        if (signIn > lastAction) continue;
        sessions.push({ rep, in: signIn, out: signOut });
        const lunch = base + (12 + rand()) * HOUR;
        for (let at = signIn + 3 * MIN; at < lastAction; at += (3 + rand() * 5) * MIN) {
          if (at > lunch && at < lunch + 45 * MIN) continue;
          actions.push({ rep, kind: rand() < 0.8 ? 'leadopen' : 'note', leadId: ids[Math.floor(rand() * ids.length)], at });
        }
        if (stillIn) actions.push({ rep, kind: 'leadopen', leadId: ids[0], at: lastAction });
      }
    });
    return { sessions, actions };
  })(),

  // ── LEADS ──
  // Phone numbers are stored as 10 digits. Phones are listed mobiles first, then landlines.
  // DBA and extra addresses are filled in only when the application or statements show them.
  // status: NEW · ATTEMPTED · ENGAGED · CONTRACT · IGNORE. rep: the rep who owns the lead ('' = unassigned).
  // touch: the history of each email address and phone number (a Touchpoint), keyed by the address or the 10-digit number.
  //        state: never · queued · attempted · sent · delivered · failed · replied · opened · clicked · unsubscribed · stop · invalid · suppressed · dnc
  //        at: when it last changed. Anything not listed has never been contacted.
  leads: [
    { id: 1, company: 'Apex Dynamics', legal: 'Apex Dynamics Holdings LLC', dba: '', ein: '84-2917336', industry: 'Industrial Automation', started: '2014-03-12',
      address: '1450 Mission St, San Francisco, CA 94103', address2: '88 King St, Unit 4, San Francisco, CA 94107', applied: '2026-09-02',
      first: 'Sandra', last: 'Reeves', dob: '1981-06-04', ssn: '901-44-8830',
      status: 'ENGAGED', rep: 'Marcus', stage: 'negotiation', value: 240000, prob: 68, closeDate: 'Sep 30, 2026', lastActive: ago(60),
      phones: [{ type: 'mobile', num: '4153097723' }, { type: 'mobile', num: '4155550148' }, { type: 'landline', num: '4158824401' }, { type: 'landline', num: '4155550112' }],
      emails: ['s.reeves@apexdyn.com', 'assistant@apexdyn.com', 'sandra.reeves@outlook.com'],
      touch: { 's.reeves@apexdyn.com': { state: 'replied', at: ago(2880) }, 'assistant@apexdyn.com': { state: 'attempted', at: ago(12960) }, '4153097723': { state: 'delivered', at: ago(2880) } },
      bank: { name: 'Chase', account: '483920117765', deposits: 412000, balance: 186000, obligations: 21500, nsf: 0, months: 6, mtd: { day: 22, balance: 191400 } },
      notes: 'Interested in enterprise tier. Mentioned rollout timeline pressure — wants contract signed before Q4 budget freeze. Follow up on security questionnaire.',
      history: [{ type: 'email', subject: 'Demo invite sent', preview: 'Zoom link for today at 4:00 PM', date: 'Today' }, { type: 'call', subject: 'Discovery call — 38 min', preview: 'Discussed pain points, budget confirmed $200–260K', date: 'Aug 19' }, { type: 'email', subject: 'Proposal sent — v2', preview: 'Updated pricing, added 120-seat tier', date: 'Aug 18' }, { type: 'meet', subject: 'Stakeholder intro · Apex IT team', preview: 'Met CTO and IT Director, good reception', date: 'Aug 12' }] },
    { id: 2, company: 'Meridian Capital', legal: 'Meridian Capital Partners LP', dba: 'Meridian Capital', ein: '13-4408215', industry: 'Financial Services', started: '2009-09-01',
      address: '375 Park Ave, Fl 12, New York, NY 10152', applied: '2026-08-27',
      first: 'James', last: 'Liao', dob: '1976-02-19', ssn: '912-30-5561',
      status: 'ATTEMPTED', rep: 'Sam', stage: 'proposal', value: 185000, prob: 55, closeDate: 'Oct 15, 2026', lastActive: ago(25),
      phones: [{ type: 'mobile', num: '2125549031' }, { type: 'landline', num: '2125548820' }, { type: 'landline', num: '2125550176' }],
      emails: ['j.liao@meridian.com', 'finance@meridian.com', 'jliao.personal@gmail.com'],
      touch: { 'j.liao@meridian.com': { state: 'opened', at: ago(7200) }, 'jliao.personal@gmail.com': { state: 'unsubscribed', at: ago(28800) }, '2125549031': { state: 'sent', at: ago(7200) } },
      bank: { name: 'Bank of America', account: '004471829356', deposits: 268000, balance: 94000, obligations: 82000, nsf: 2, months: 6, mtd: { day: 21, balance: 88700 } },
      notes: 'CFO wants two payment options. Prefers a call over email.',
      history: [{ type: 'call', subject: 'Pricing call — 22 min', preview: 'Asked about 24-month terms', date: 'Today' }, { type: 'email', subject: 'Proposal sent', preview: 'Includes two payment options', date: 'Sep 22' }] },
    { id: 3, company: 'Nova Logistics', legal: 'Nova Logistics Inc.', dba: '', ein: '36-4791052', industry: 'Freight & Logistics', started: '2017-05-22',
      address: '2201 W Fulton St, Chicago, IL 60612', address2: '1800 S Canal St, Chicago, IL 60616', address3: '4400 W 45th St, Chicago, IL 60632', applied: '2026-09-10',
      first: 'Priya', last: 'Tandon', dob: '1988-11-30', ssn: '923-18-2204',
      status: 'NEW', rep: 'Mike', stage: 'qualified', value: 120000, prob: 40, closeDate: 'Oct 22, 2026', lastActive: ago(190),
      phones: [{ type: 'mobile', num: '3127792241' }, { type: 'mobile', num: '3125550133' }],
      emails: ['p.tandon@novalog.io', 'ops@novalog.io'],
      touch: {},
      bank: { name: 'Wells Fargo', account: '7730218845', deposits: 175000, balance: 52000, obligations: 18000, nsf: 0, months: 4 },
      notes: 'Wants a demo for her engineering team before deciding.',
      history: [{ type: 'meet', subject: 'Tech review call', preview: 'Met her engineering lead', date: 'Today' }, { type: 'email', subject: 'Intro email', preview: 'Sent overview deck', date: 'Sep 18' }] },
    { id: 4, company: 'Evergreen Tech', legal: 'Evergreen Technology Group LLC', dba: '', ein: '93-1886420', industry: 'IT Services', started: '2019-01-15',
      address: '910 NW Glisan St, Portland, OR 97209', applied: '2026-09-14',
      first: 'Ben', last: 'Kowalski', dob: '1984-07-08', ssn: '934-52-7719',
      status: 'ATTEMPTED', rep: 'Sarah', stage: 'discovery', value: 95000, prob: 25, closeDate: 'Nov 5, 2026', lastActive: ago(1440),
      phones: [{ type: 'mobile', num: '5035550187' }, { type: 'landline', num: '5036614490' }],
      emails: ['b.kowalski@evg.tech'],
      touch: { 'b.kowalski@evg.tech': { state: 'failed', at: ago(4320) }, '5035550187': { state: 'attempted', at: ago(4320) } },
      bank: { name: 'U.S. Bank', account: '153600927418', deposits: 132000, balance: 31000, obligations: 44000, nsf: 3, months: 3 },
      notes: 'Needs finance approval before moving forward.',
      history: [{ type: 'call', subject: 'Discovery call — 15 min', preview: 'Needs approval from finance', date: 'Yesterday' }, { type: 'email', subject: 'First outreach', preview: 'No reply yet', date: 'Sep 17' }] },
    { id: 5, company: 'Stellar Ops', legal: 'Stellar Operations Corp.', dba: 'Stellar Ops', ein: '77-0529184', industry: 'Managed IT', started: '2012-08-03',
      address: '3000 N First St, San Jose, CA 95134', address2: '47 E Santa Clara St, San Jose, CA 95113', applied: '2026-08-19',
      first: 'Mei', last: 'Chen', dob: '1983-04-25', ssn: '945-66-1038',
      status: 'CONTRACT', rep: 'Marcus', stage: 'negotiation', value: 310000, prob: 75, closeDate: 'Sep 25, 2026', lastActive: ago(12),
      phones: [{ type: 'mobile', num: '4082291170' }, { type: 'mobile', num: '4085550119' }, { type: 'landline', num: '4082298832' }, { type: 'landline', num: '4085550164' }],
      emails: ['m.chen@stellarops.com', 'itdesk@stellarops.com', 'billing@stellarops.com'],
      touch: { 'm.chen@stellarops.com': { state: 'replied', at: ago(1440) }, 'billing@stellarops.com': { state: 'invalid', at: ago(36000) }, '4082291170': { state: 'replied', at: ago(1440) } },
      bank: { name: 'Chase', account: '902215734061', deposits: 455000, balance: 210000, obligations: 38000, nsf: 0, months: 6, mtd: { day: 23, balance: 224800 } },
      notes: 'Asked for a volume discount on a 3-year term.',
      history: [{ type: 'call', subject: 'Pricing review — 41 min', preview: 'Asked for a volume discount', date: 'Today' }, { type: 'email', subject: 'Revised quote', preview: 'Added 3-year option', date: 'Sep 23' }, { type: 'meet', subject: 'Contract walkthrough', preview: 'Legal joined the call', date: 'Sep 21' }] },
    { id: 6, company: 'QuantumBridge', legal: 'QuantumBridge Technologies Inc.', dba: '', ein: '82-3310457', industry: 'Software', started: '2021-02-10',
      address: '120 W 45th St, New York, NY 10036', applied: '2026-09-18',
      first: 'David', last: 'Ruiz', dob: '1979-12-14', ssn: '956-07-3342',
      status: 'ENGAGED', rep: 'Sam', stage: 'prospecting', value: 450000, prob: 15, closeDate: 'Nov 30, 2026', lastActive: ago(4320),
      phones: [{ type: 'mobile', num: '6465550191' }, { type: 'landline', num: '6463371122' }],
      emails: ['d.ruiz@qbridge.ai', 'assistant@qbridge.ai'],
      touch: { 'd.ruiz@qbridge.ai': { state: 'clicked', at: ago(5760) }, '6465550191': { state: 'stop', at: ago(17280) } },
      bank: { name: 'Citibank', account: '4988103276', deposits: 620000, balance: 305000, obligations: 96000, nsf: 0, months: 2 },
      notes: 'Early stage. Reach the CEO through his assistant.',
      history: [{ type: 'email', subject: 'Intro email', preview: 'Opened twice, no reply', date: 'Sep 21' }] },
    { id: 7, company: 'Pinnacle Health', legal: 'Pinnacle Health Partners PLLC', dba: 'Pinnacle Health', ein: '04-3620198', industry: 'Healthcare', started: '2008-06-30',
      address: '800 Boylston St, Boston, MA 02199', applied: '2026-07-28',
      first: 'Alicia', last: 'Hayes', dob: '1974-09-02', ssn: '967-21-6605',
      status: 'IGNORE', rep: 'Mike', stage: 'closed-won', value: 175000, prob: 100, closeDate: 'Aug 15, 2026', lastActive: ago(10080),
      phones: [{ type: 'mobile', num: '6175550127' }, { type: 'landline', num: '6174920033' }],
      emails: ['a.hayes@pinnaclehlth.com', 'operations@pinnaclehlth.com'],
      touch: { 'a.hayes@pinnaclehlth.com': { state: 'unsubscribed', at: ago(43200) } },
      bank: { name: 'TD Bank', account: '8246619037', deposits: 240000, balance: 118000, obligations: 15000, nsf: 0, months: 6 },
      notes: 'Signed. Onboarding starts next week.',
      history: [{ type: 'call', subject: 'Kickoff call — 30 min', preview: 'Onboarding scheduled', date: 'Sep 17' }, { type: 'email', subject: 'Contract signed', preview: 'Signed by both sides', date: 'Aug 15' }] },
    { id: 8, company: 'SyncWave', legal: 'SyncWave Networks LLC', dba: '', ein: '75-2984413', industry: 'Telecommunications', started: '2016-10-11',
      address: '2100 Ross Ave, Dallas, TX 75201', applied: '2026-09-05',
      first: 'Thomas', last: 'Patel', dob: '1985-03-17', ssn: '978-39-4471',
      status: 'NEW', rep: 'Sarah', stage: 'proposal', value: 205000, prob: 55, closeDate: 'Oct 10, 2026', lastActive: ago(90),
      phones: [{ type: 'mobile', num: '2145550138' }, { type: 'mobile', num: '2145550156' }, { type: 'landline', num: '2148835560' }],
      emails: ['t.patel@syncwave.io', 'ops@syncwave.io'],
      touch: {},
      bank: { name: 'Capital One', account: '3610457729', deposits: 290000, balance: 87000, obligations: 52000, nsf: 1, months: 5, mtd: { day: 20, balance: 79300 } },
      notes: 'Focused on how fast the setup can be done.',
      history: [{ type: 'email', subject: 'Proposal follow-up', preview: 'Asked about implementation time', date: 'Today' }, { type: 'meet', subject: 'Proposal review', preview: 'Walked through pricing', date: 'Sep 20' }] },
    { id: 9, company: 'Orbis Analytics', legal: 'Orbis Analytics Co.', dba: '', ein: '84-4129067', industry: 'Data & Analytics', started: '2020-04-06',
      address: '1601 Wewatta St, Denver, CO 80202', applied: '2026-09-16',
      first: 'Laura', last: 'Fischer', dob: '1990-01-23', ssn: '989-12-5503',
      status: 'ATTEMPTED', rep: 'Marcus', stage: 'discovery', value: 88000, prob: 25, closeDate: 'Nov 18, 2026', lastActive: ago(2880),
      phones: [{ type: 'landline', num: '7204419987' }],
      emails: ['l.fischer@orbis.co'],
      touch: { 'l.fischer@orbis.co': { state: 'attempted', at: ago(21600) } },
      bank: { name: 'Wells Fargo', account: '6602934418', deposits: 118000, balance: 26000, obligations: 39000, nsf: 4, months: 3 },
      notes: 'Asked for a case study from a similar company.',
      history: [{ type: 'email', subject: 'Intro email', preview: 'Asked for a case study', date: 'Sep 22' }] },
    { id: 10, company: 'Vertex Systems', legal: 'Vertex Systems Inc.', dba: '', ein: '94-3371820', industry: 'Enterprise Software', started: '2011-11-01',
      address: '555 California St, San Francisco, CA 94104', applied: '2026-09-08',
      first: 'Nathan', last: 'Kim', dob: '1982-08-12', ssn: '990-47-2286',
      status: 'NEW', rep: 'Sam', stage: 'qualified', value: 142000, prob: 45, closeDate: 'Oct 28, 2026', lastActive: ago(300),
      phones: [{ type: 'mobile', num: '4155550170' }, { type: 'landline', num: '4156673345' }],
      emails: ['n.kim@vertexsys.com', 'it@vertexsys.com'],
      touch: {},
      bank: { name: 'Silicon Valley Bank', account: '3300781526', deposits: 205000, balance: 71000, obligations: 28000, nsf: 0, months: 6 },
      notes: 'Wants to test the integration first.',
      history: [{ type: 'call', subject: 'Technical review — 27 min', preview: 'Wants an integration test', date: 'Today' }, { type: 'email', subject: 'Security questions', preview: 'Sent the security summary', date: 'Sep 19' }] },
    { id: 11, company: 'ClearPath Fin.', legal: 'ClearPath Financial LLC', dba: 'ClearPath Funding', ein: '36-5520913', industry: 'Lending', started: '2015-07-20',
      address: '233 S Wacker Dr, Chicago, IL 60606', applied: '2026-08-11',
      first: 'Olivia', last: 'Brooks', dob: '1987-05-09', ssn: '901-83-9914',
      status: 'ATTEMPTED', rep: 'Mike', stage: 'closed-lost', value: 98000, prob: 0, closeDate: '—', lastActive: ago(20160),
      phones: [{ type: 'landline', num: '3125587712' }],
      emails: ['o.brooks@clearpath.com'],
      touch: { 'o.brooks@clearpath.com': { state: 'sent', at: ago(57600) } },
      bank: { name: 'PNC Bank', account: '5093378214', deposits: 98000, balance: 12000, obligations: 47000, nsf: 6, months: 4 },
      notes: 'Chose another vendor on price. Try again in Q1.',
      history: [{ type: 'call', subject: 'Closing call', preview: 'Went with another vendor', date: 'Sep 10' }, { type: 'note', subject: 'Lost — price', preview: 'Try again in Q1', date: 'Sep 10' }] },
    { id: 12, company: 'Horizon Cloud', legal: 'Horizon Cloud Security Inc.', dba: '', ein: '74-3098152', industry: 'Cybersecurity', started: '2013-01-28',
      address: '600 Congress Ave, Austin, TX 78701', address2: '11501 Alterra Pkwy, Austin, TX 78758', applied: '2026-08-30',
      first: 'Rafael', last: 'Gomez', dob: '1980-10-31', ssn: '912-75-0428',
      status: 'ENGAGED', rep: 'Sarah', stage: 'negotiation', value: 330000, prob: 70, closeDate: 'Sep 28, 2026', lastActive: ago(45),
      phones: [{ type: 'mobile', num: '5128824177' }, { type: 'mobile', num: '5125550162' }, { type: 'landline', num: '5128824100' }, { type: 'landline', num: '5125550109' }],
      emails: ['r.gomez@horizoncloud.io', 'security@horizoncloud.io', 'rafael.gomez@outlook.com'],
      touch: { 'r.gomez@horizoncloud.io': { state: 'delivered', at: ago(8640) }, 'security@horizoncloud.io': { state: 'dnc', at: ago(86400) }, '5128824177': { state: 'delivered', at: ago(8640) }, '5125550162': { state: 'failed', at: ago(8640) } },
      bank: { name: 'Frost Bank', account: '271094463850', deposits: 470000, balance: 198000, obligations: 44000, nsf: 0, months: 6, mtd: { day: 22, balance: 203600 } },
      notes: 'Needs SOC2 report and a pen test summary.',
      history: [{ type: 'call', subject: 'Security review — 35 min', preview: 'Wants a pen test summary', date: 'Today' }, { type: 'email', subject: 'Security package sent', preview: 'SOC2 report attached', date: 'Sep 22' }] }
  ],

  // ── LEADS · PANEL 3 ──
  // Texts: [channel, number, direction, text, minutes ago, phone, unread, receipt]
  // receipt (messages you sent): 'sent', 'delivered' (when left out) or the minutes ago it was read.
  messages: [
    ['text', '4153097723', 'out', 'Hi Sandra, sending the Zoom link for today’s demo.', 310, 1, false, 305],
    ['text', '4153097723', 'in', 'Perfect, thanks! Can we cover SSO too?', 296, 1],
    ['text', '4153097723', 'out', 'Absolutely — I’ll add it to the agenda.', 290, 1, false, 288],
    ['text', '2125549031', 'out', 'Hi James, the proposal with both payment options is in your inbox.', 3000, 1, false, 2990],
    ['text', '2125549031', 'in', 'Got it. Reviewing it with the board this week.', 2950, 1],
    ['text', '2125549031', 'in', 'Can we move our call to 3:00 PM on Monday?', 22, 1, true],
    ['text', '4082291170', 'in', 'Legal is fine with the 3-year term.', 1400, 2],
    ['text', '4082291170', 'out', 'Great news! I’ll send the final paperwork today.', 1380, 2],
    ['wa', '4082291170', 'in', 'Can you send the volume pricing table here?', 200, 2],
    ['wa', '4082291170', 'out', 'Sure — sending it over in a few minutes.', 190, 2, false, 186],
    ['wa', '5128824177', 'out', 'Hi Rafael, do you have a contact for the pen test?', 300, 1, false, 296],
    ['wa', '5128824177', 'in', 'Sent the pen test request to our team. We should have it by Friday.', 41, 1, true],
    ['text', '2145550138', 'in', 'How long does setup usually take?', 100, 1],
    ['text', '2145550138', 'out', 'Most teams are live in 2 weeks. Happy to walk you through it.', 92, 1],
    ['text', '3127792241', 'out', 'Hi Priya, confirming Wednesday at 11 AM for the demo.', 2000, 2, false, 1996],
    ['text', '3127792241', 'in', 'Confirmed 👍', 1990, 2],
    ['wa', '6465550191', 'out', 'Hi David, this is Sam from CRM. Do you have 10 minutes this week?', 4400, 1],
    ['text', '4155550170', 'in', 'Integration test passed on our side.', 330, 2, true],
    ['text', '5035550187', 'out', 'Hi Ben, any update from finance?', 1500, 1],
    ['wa', '6175550127', 'in', 'Thanks for the onboarding call!', 9000, 2]
  ],
  // Calls: [number, direction (out / in / missed), minutes ago, seconds talked, phone]
  calls: [
    ['4082291170', 'missed', 8, 0, 1], ['7865550142', 'missed', 130, 0, 1], ['2125548820', 'out', 180, 1320, 1],
    ['3127792241', 'out', 190, 0, 2], ['5128824100', 'out', 240, 2100, 1], ['4156673345', 'in', 290, 1620, 2],
    ['4082298832', 'out', 420, 2460, 2], ['4153097723', 'in', 1500, 402, 1], ['5036614490', 'out', 1510, 900, 1],
    ['2148835560', 'missed', 2600, 0, 1], ['6174920033', 'out', 11000, 1800, 2], ['3125587712', 'out', 21000, 540, 1]
  ],
  // Numbers on an iPhone get blue iMessage bubbles; every other text is a green SMS bubble.
  imessageNumbers: ['4153097723', '4082291170', '5128824177', '2125549031', '6465550191', '3127792241'],

  // ── FOLLOW-UP REMINDERS ──
  // Copied into this browser the first time the CRM opens (nv.reminders); after that the saved ones are used.
  // at: when it is due, as minutes from now (ago(-90) is 90 minutes from now). type: call, meet or remind (the icon).
  reminders: [
    { leadId: 1, type: 'call', text: 'Follow-up call', at: ago(20) },
    { leadId: 1, type: 'meet', text: 'Product demo — enterprise tier walkthrough', at: ago(-90) },
    { leadId: 2, type: 'call', text: 'Follow-up call', at: ago(15) },
    { leadId: 3, type: 'meet', text: 'Product demo', at: ago(-2 * 1440) },
    { leadId: 4, type: 'call', text: 'Discovery follow-up', at: ago(-1440) },
    { leadId: 5, type: 'call', text: 'Final pricing call', at: ago(-300) },
    { leadId: 6, type: 'call', text: 'Initial outreach call', at: ago(-45) },
    { leadId: 7, type: 'meet', text: 'Onboarding session', at: ago(-1500) },
    { leadId: 8, type: 'call', text: 'Proposal review call', at: ago(-3 * 1440) },
    { leadId: 9, type: 'call', text: 'Needs assessment call', at: ago(-2 * 1440 - 120) },
    { leadId: 10, type: 'meet', text: 'Technical deep dive', at: ago(-4 * 1440) },
    { leadId: 12, type: 'meet', text: 'Security follow-up', at: ago(-200) }
  ],

  // ── NOTIFICATIONS ──
  // Each alert points at the call, message or email it is about, so nothing is typed twice.
  notifications: [
    { id: 'n1', kind: 'call', ref: 'c0' }, { id: 'n2', kind: 'sms', ref: 'm5' }, { id: 'n3', kind: 'wa', ref: 'm11' },
    { id: 'n4', kind: 'email', ref: 't-priya-demo' }, { id: 'n5', kind: 'call', ref: 'c1' },
    { id: 'n7', kind: 'open', leadId: 5 }, { id: 'n8', kind: 'open', leadId: 12 }
  ],

  // ── EMAIL ──
  // Each address belongs to one rep; reps see only their own mail. The owner's All reps shows every rep's.
  mailAccounts: [
    { id: 'a1', rep: 'Marcus', name: 'Marcus Webb', email: 'marcus.webb@crm.mail', color: '#1A73E8', signature: '<div>Marcus Webb</div><div>Senior Account Executive · CRM</div>' },
    { id: 'a2', rep: 'Marcus', name: 'Marcus Webb', email: 'mwebb@crm.mail', color: '#188038', signature: '<div>Marcus Webb</div><div>CRM</div>' },
    { id: 'a3', rep: 'Sam', name: 'Sam', email: 'sam@crm.mail', color: '#9334E6', signature: '<div>Sam</div><div>CRM</div>' },
    { id: 'a4', rep: 'Sarah', name: 'Sarah Lane', email: 'sarah.lane@crm.mail', color: '#E8710A', signature: '<div>Sarah Lane</div><div>Account Executive · CRM</div>' },
    { id: 'a5', rep: 'Mike', name: 'Mike Ortiz', email: 'mike.ortiz@crm.mail', color: '#12B5CB', signature: '<div>Mike Ortiz</div><div>Account Executive · CRM</div>' }
  ],

  // Email templates, loaded the first time the CRM opens. Campaigns fill in {first}, {last}, {company} and {rep}.
  mailTemplates: [
    { id: 'tp-intro', name: 'Intro — working capital', subject: 'Working capital for {company}',
      html: '<div>Hi {first},</div><div><br></div><div>I work with businesses like {company} that want fast, simple working capital. Most of our clients get an answer within a day.</div><div><br></div><div>Would a quick 10-minute call this week make sense?</div><div><br></div><div>{rep}</div>' },
    { id: 'tp-follow', name: 'Follow up — no reply', subject: 'Following up, {first}',
      html: '<div>Hi {first},</div><div><br></div><div>Just circling back on my last note. If funding is still on your list for {company}, I can have numbers for you in 24 hours.</div><div><br></div><div>{rep}</div>' },
    { id: 'tp-renew', name: 'Renewal check-in', subject: '{company} — renewal options',
      html: '<div>Hi {first},</div><div><br></div><div>You may qualify for a renewal with better terms. Want me to run the numbers?</div><div><br></div><div>{rep}</div>' }
  ],

  // Sample mailbox, loaded the first time the CRM opens. account: its place in mailAccounts (0 = first). mins: minutes ago.
  // out: sent by the account's rep (opens: minutes ago of each open). hi: starts the email with "Hi <first name>," of the lead.
  // mailboxVersion: when the sample mailbox changes, this number goes up and the sample emails are loaded again
  // (emails a rep wrote in new conversations are kept).
  mailboxVersion: 2,
  mailbox: [
    { id: 't-priya-demo', account: 4, folder: 'inbox', msgs: [
      { out: true, peer: 'p.tandon@novalog.io', subject: 'Product demo', hi: true, body: 'Would Wednesday at 11 AM work for the product demo with your engineering team?', mins: 400, opens: [300] },
      { peer: 'p.tandon@novalog.io', subject: 'Re: Product demo', body: 'Hi Mike,\n\nWednesday at 11 works. I will bring two engineers.\n\nThanks,\nPriya', mins: 95, unread: true }] },
    { id: 't-mei-quote', account: 0, folder: 'inbox', starred: true, important: true, msgs: [
      { out: true, peer: 'm.chen@stellarops.com', subject: 'Revised quote — 3-year option', hi: true, body: 'Attached is the revised quote with the 3-year option we discussed.', mins: 2200, opens: [9, 35, 400, 1300, 2100] },
      { peer: 'm.chen@stellarops.com', subject: 'Re: Revised quote — 3-year option', body: 'Hi Marcus,\n\nLegal signed off on the 3-year term. Can you confirm the volume discount is included?\n\nMei', mins: 70, unread: true }] },
    { id: 't-thomas-timeline', account: 3, folder: 'inbox', msgs: [
      { peer: 't.patel@syncwave.io', subject: 'Implementation timeline', body: 'Hi Sarah,\n\nCould you share a rough implementation timeline for 200 seats?\n\nThomas', mins: 130 }] },
    { id: 't-james-payment', account: 2, folder: 'inbox', msgs: [
      { peer: 'j.liao@meridian.com', subject: 'Payment options', body: 'Sam,\n\nOne question on option B — is the first payment due at signing?\n\nJames', mins: 1500 }] },
    { id: 't-rafael-soc2', account: 3, folder: 'inbox', starred: true, msgs: [
      { peer: 'r.gomez@horizoncloud.io', subject: 'SOC2 follow-up', body: 'Hi Sarah,\n\nThanks for the SOC2 report. Our team will review it this week.\n\nRafael', mins: 4100 }] },
    { id: 't-alicia-onboarding', account: 4, folder: 'inbox', msgs: [
      { peer: 'a.hayes@pinnaclehlth.com', subject: 'Onboarding next week', body: 'Hi Mike,\n\nWe are all set for onboarding on Tuesday. Looking forward to it.\n\nAlicia', mins: 9500 }] },
    { id: 't-sandra-demo', account: 0, folder: 'archive', msgs: [
      { out: true, peer: 's.reeves@apexdyn.com', subject: 'Demo invite — enterprise tier', hi: true, body: 'Here is the Zoom link for today’s enterprise tier demo at 4:00 PM.', mins: 300, opens: [20, 140, 290] }] },
    { id: 't-james-proposal', account: 2, folder: 'archive', msgs: [
      { out: true, peer: 'j.liao@meridian.com', subject: 'Proposal — two payment options', hi: true, body: 'The proposal with both payment options is attached for your review.', mins: 2900, opens: [2850] }] },
    { id: 't-priya-deck', account: 4, folder: 'archive', msgs: [
      { out: true, peer: 'p.tandon@novalog.io', subject: 'Overview deck', hi: true, body: 'Sharing our overview deck ahead of the demo.', mins: 9500 }] },
    { id: 't-ben-intro', account: 3, folder: 'archive', msgs: [
      { out: true, peer: 'b.kowalski@evg.tech', subject: 'Intro — CRM', hi: true, body: 'Great speaking with you. Here is a short intro to CRM.', mins: 11600 }] },
    { id: 't-david-intro', account: 2, folder: 'archive', msgs: [
      { out: true, peer: 'd.ruiz@qbridge.ai', subject: 'Intro — CRM', hi: true, body: 'Do you have 10 minutes this week for a quick intro call?', mins: 5800, opens: [5500, 5700] }] },
    { id: 't-alicia-contract', account: 4, folder: 'archive', msgs: [
      { out: true, peer: 'a.hayes@pinnaclehlth.com', subject: 'Contract signed — next steps', hi: true, body: 'Thank you for signing. Next steps for onboarding are below.', mins: 58000, opens: [57000] }] },
    { id: 't-thomas-proposal', account: 3, folder: 'archive', msgs: [
      { out: true, peer: 't.patel@syncwave.io', subject: 'Proposal follow-up', hi: true, body: 'Following up on the proposal we reviewed together.', mins: 150, opens: [95] }] },
    { id: 't-nathan-security', account: 2, folder: 'archive', msgs: [
      { out: true, peer: 'n.kim@vertexsys.com', subject: 'Security summary', hi: true, body: 'Here is the security summary your team asked for.', mins: 8800, opens: [4000, 8700] }] },
    { id: 't-rafael-package', account: 3, folder: 'archive', msgs: [
      { out: true, peer: 'r.gomez@horizoncloud.io', subject: 'Security package — SOC2 report', hi: true, body: 'The SOC2 report and security package are attached.', mins: 4300, opens: [60, 2600, 4200] }] },
    { id: 't-laura-draft', account: 0, folder: 'archive', msgs: [
      { out: true, draft: true, peer: 'l.fischer@orbis.co', subject: 'Case study for Orbis', body: 'Hi Laura,\n\nHere is a case study from a data team like yours.', mins: 60 }] }
  ],

  // ── SCANNER ──
  // A batch paused part-way, fed in through the same calls the scanner engine will use (see scan.js).
  scanner: {
    batchId: 'SEP25-762',
    upload: { status: 'paused', sourceType: 'zip', sourceName: 'September Batch.zip', filesPrepared: 500, filesTotal: 500 },
    progress: { completed: 147, total: 500, regularScanned: 132, skipped: 10, ocrNeeded: 4, failed: 1, elapsed: 222, eta: 490, activeLanes: [
      { laneId: 1, originalName: 'ABC Funding Application 09-25-2026 Final Signed.pdf' },
      { laneId: 2, originalName: 'Northstar Supply September Bank Statement 2026.pdf' },
      { laneId: 3, originalName: 'Metro Foods August Statement.pdf' },
      { laneId: 4, originalName: 'Delta Supply Month To Date Statement.pdf' }] },
    results: [
      { id: 'abc-funding', company: 'ABC Funding LLC', owner: 'Michael Torres', revenue: 118000,
        statements: [{ period: 'MTD', deposits: 42000, balance: 50000 }, { period: 'SEP', deposits: 250000, balance: 50000 }, { period: 'AUG', deposits: 300000, balance: 100000 }, { period: 'JUL', deposits: 250000, balance: 50000 }],
        phones: ['9175550142', '6465558831'], emails: ['owner@abcfunding.com', 'office@abcfunding.com'], dob: '1979-04-12', appDate: '2026-09-25',
        businessAddress: '410 W 34th St, New York, NY 10001', applicationAddress: '12 Elm Ct, Hoboken, NJ 07030', ein: '46-3381902',
        bank: 'Chase Business Complete', account: 'XXXXXX6700', mca: [{ company: 'Rapid Capital', payment: 1250, frequency: 'Daily', monthlyTotal: 26250 }], dailyCashFlow: 8200 },
      { id: 'northstar-supply', company: 'Northstar Supply Co', companyAlt: 'Northstar Supply Company Inc', owner: 'Dana Whitfield', revenue: 85000,
        statements: [{ period: 'AUG', deposits: 92000, balance: 16400 }, { period: 'JUL', deposits: 88000, balance: 9800 }],
        phones: ['7185550199'], emails: ['dana@northstarsupply.com'], dob: '1984-11-02', appDate: '2026-09-24',
        businessAddress: '88 Industrial Way, Newark, NJ 07105', applicationAddress: '88 Industrial Way, Newark, NJ 07105', ein: '22-4410987',
        bank: 'TD Bank', account: 'XXXXXX2291', mca: [], dailyCashFlow: 3100 },
      { id: 'metro-foods', company: 'Metro Foods Inc', dba: 'Metro Kitchen', owner: 'Luis Ortega', ownerAlt: 'Luis A Ortega', revenue: 150000,
        statements: [{ period: 'AUG', deposits: 162500, balance: 41200 }, { period: 'JUL', deposits: 148900, balance: 38750 }, { period: 'JUN', deposits: 151300, balance: 29400 }],
        phones: ['3055550117', '7865550164'], emails: ['luis@metrokitchen.com', 'books@metrokitchen.com'], dob: '1975-06-19', appDate: '2026-09-23',
        businessAddress: '2100 NW 2nd Ave, Miami, FL 33127', businessAddressAlt: '2100 NW 2nd Ave, Ste 4, Miami, FL 33127', applicationAddress: '15 Palm Ln, Miami, FL 33133', ein: '65-1182044',
        bank: 'Bank of America Business Advantage', account: 'XXXXXX4418', mca: [{ company: 'Fundry', payment: 890, frequency: 'Daily', monthlyTotal: 18690 }, { company: 'Kapitus', payment: 2400, frequency: 'Weekly', monthlyTotal: 10400 }], dailyCashFlow: 5400 },
      { id: 'delta-supply', company: 'Delta Supply Partners', owner: 'Karen Liu', revenue: 36500,
        statements: [{ period: 'AUG', deposits: 38100, balance: 18250 }, { period: 'JUL', deposits: 35200, balance: 12900 }],
        phones: ['2145550163'], emails: ['karen@deltasupply.co'], dob: '1988-01-27', appDate: '2026-09-22',
        businessAddress: '901 Commerce St, Dallas, TX 75202', applicationAddress: '901 Commerce St, Dallas, TX 75202', ein: '81-2297361',
        bank: 'Wells Fargo', account: 'XXXXXX0935', mca: [], dailyCashFlow: null },
      { id: 'harbor-auto', company: 'Harbor Auto Group', owner: 'Victor Nash', revenue: 1200000,
        statements: [{ period: 'AUG', deposits: 1310000, balance: 214000 }, { period: 'JUL', deposits: 1185000, balance: 198500 }, { period: 'JUN', deposits: 1242000, balance: 176300 }],
        phones: ['6175550188'], emails: ['vnash@harborauto.com', 'finance@harborauto.com'], dob: '1969-09-08', appDate: '2026-09-25',
        businessAddress: '500 Harbor Blvd, Quincy, MA 02169', applicationAddress: '7 Beacon Rd, Milton, MA 02186', ein: '04-3718820',
        bank: 'Citizens Bank', account: 'XXXXXX5521', mca: [{ company: 'Pearl Capital', payment: 4200, frequency: 'Weekly', monthlyTotal: 18200 }], dailyCashFlow: 41600 },
      { id: 'pinewood-dental', company: 'Pinewood Dental PC', owner: 'Dr. Aisha Grant', revenue: 90000,
        statements: [{ period: 'AUG', deposits: 97400, balance: 22800 }, { period: 'JUL', deposits: null, balance: 19100 }],
        phones: ['4045550122'], emails: [], dob: '1981-03-15', appDate: '2026-09-21',
        businessAddress: '3300 Peachtree Rd, Atlanta, GA 30326', applicationAddress: '3300 Peachtree Rd, Atlanta, GA 30326', ein: '58-2940017',
        bank: 'Truist', account: 'XXXXXX8804', mca: [], dailyCashFlow: 2900 },
      { id: 'summit-roofing', company: 'Summit Roofing', owner: 'Greg Ward', revenue: 64000,
        statements: [{ period: 'AUG', deposits: 61800, balance: 7400 }, { period: 'JUL', deposits: 66300, balance: 9150 }],
        phones: [], emails: [], dob: '', appDate: '2026-09-22',
        businessAddress: '42 Ridge Rd, Denver, CO 80212', applicationAddress: '', ein: '',
        bank: 'US Bank', account: '', mca: [], dailyCashFlow: null },
      { id: 'crescent-logistics', company: 'Crescent Logistics', owner: 'Omar Haddad', revenue: null,
        statements: [{ period: 'AUG', deposits: 128400, balance: 33600 }],
        phones: ['3125550176'], emails: ['omar@crescentlogistics.com'], dob: '1990-12-03', appDate: '',
        businessAddress: '1200 W Fulton Market, Chicago, IL 60607', applicationAddress: '', ein: '36-5018842',
        bank: 'PNC Bank', account: 'XXXXXX1167', mca: [], dailyCashFlow: null }
    ],
    rescan: [
      { id: 'd-crescent-app', originalName: 'Crescent Logistics Application Scan.pdf', company: 'Crescent Logistics', method: 'ocr', reasons: ['OCR Recommended', 'Missing Revenue'] },
      { id: 'd-pinewood-jul', originalName: 'Pinewood Dental July Statement.pdf', company: 'Pinewood Dental PC', method: 'ocr', reasons: ['Weak Text', 'Financial Data'] },
      { id: 'd-summit-app', originalName: 'Summit Roofing Application 09-22-2026.pdf', company: 'Summit Roofing', method: 'ocr', reasons: ['Missing Email', 'Missing Phone'] },
      { id: 'd-harbor-mtd', originalName: 'Harbor Auto Group Month To Date Statement.pdf', company: 'Harbor Auto Group', method: 'ocr', reasons: ['Extraction Review'] }
    ],
    audit: [
      { id: 'd-abc-app', document: 'ABC Funding Application 09-25-2026 Final Signed.pdf', company: 'ABC Funding LLC', type: 'Application', text: 'Good', ocr: 'Not needed', pages: 4, extraction: 'Complete', details: '' },
      { id: 'd-abc-aug', document: 'ABC Funding August Statement.pdf', company: 'ABC Funding LLC', type: 'Statement', text: 'Good', ocr: 'Not needed', pages: 6, extraction: 'Complete', details: '' },
      { id: 'd-abc-aug-2', document: 'ABC Funding August Statement (1).pdf', company: 'ABC Funding LLC', type: 'Statement', text: 'Good', ocr: 'Not needed', pages: 6, extraction: 'Skipped', details: 'Duplicate of ABC Funding August Statement.pdf', issue: true },
      { id: 'd-northstar-app', document: 'Northstar Supply Application.pdf', company: 'Northstar Supply Co', type: 'Application', text: 'Good', ocr: 'Not needed', pages: 3, extraction: 'Complete', details: 'Company name differs from the statements', issue: true },
      { id: 'd-metro-aug', document: 'Metro Foods August Statement.pdf', company: 'Metro Foods Inc', type: 'Statement', text: 'Good', ocr: 'Not needed', pages: 8, extraction: 'Complete', details: '' },
      { id: 'd-delta-app', document: 'Delta Supply Application.pdf', company: 'Delta Supply Partners', type: 'Application', text: 'Good', ocr: 'Not needed', pages: 3, extraction: 'Complete', details: 'Revenue $36,500 is under $40,000 — kept because an ending balance is over $15,000' },
      { id: 'd-bright-app', document: 'Bright Path Tutoring Application.pdf', company: 'Bright Path Tutoring', type: 'Application', text: 'Good', ocr: 'Not needed', pages: 2, extraction: 'Skipped', details: 'Revenue $28,000 is under $40,000 and no ending balance is over $15,000' },
      { id: 'd-harbor-mtd', document: 'Harbor Auto Group Month To Date Statement.pdf', company: 'Harbor Auto Group', type: 'Statement', text: 'Weak', ocr: 'Needed', pages: 2, extraction: 'Partial', details: 'Ending balance could not be read', issue: true },
      { id: 'd-pinewood-jul', document: 'Pinewood Dental July Statement.pdf', company: 'Pinewood Dental PC', type: 'Statement', text: 'Weak', ocr: 'Needed', pages: 5, extraction: 'Partial', details: 'Deposits total not found', issue: true },
      { id: 'd-summit-app', document: 'Summit Roofing Application 09-22-2026.pdf', company: 'Summit Roofing', type: 'Application', text: 'Weak', ocr: 'Needed', pages: 3, extraction: 'Partial', details: 'No phone or email found', issue: true },
      { id: 'd-crescent-app', document: 'Crescent Logistics Application Scan.pdf', company: 'Crescent Logistics', type: 'Application', text: 'None', ocr: 'Needed', pages: 4, extraction: 'Partial', details: 'Scanned image — no text layer', issue: true },
      { id: 'd-kestrel', document: 'Kestrel Farms Statement.pdf', company: '', type: 'Statement', text: 'None', ocr: 'Not needed', pages: 0, extraction: 'Failed', details: 'File is password protected', issue: true }
    ],
    history: [
      { batchId: 'SEP24-758', at: fromWall(2026, 8, 24, 16, 12), source: 'Sept 24 apps.zip', files: 312, leads: 96, kept: 81, skipped: 12, failed: 3, notes: 'Two statements were password protected' },
      { batchId: 'SEP23-751', at: fromWall(2026, 8, 23, 10, 40), source: 'Broker folder — Sept 23', files: 188, leads: 61, kept: 55, skipped: 6, failed: 0, notes: '' },
      { batchId: 'SEP22-744', at: fromWall(2026, 8, 22, 15, 5), source: 'Sept 22 renewals.zip', files: 420, leads: 133, kept: 118, skipped: 13, failed: 2, notes: 'Rescanned 9 files with OCR' }
    ]
  },

  // ── CAMPAIGN ──
  // Senders a campaign can send from: email accounts and iPhones, one rep each.
  // state: ready · paused · offline · error. sentToday / limit: messages today and the daily limit.
  // lastSend: last successful send. heartbeat (iPhones): last time the phone checked in. error: what is wrong, if anything.
  campaignSenders: {
    email: [
      { id: 'e1', name: 'marcus.webb@crm.mail', rep: 'Marcus', state: 'ready', sentToday: 42, limit: 400, lastSend: ago(6), error: '' },
      { id: 'e2', name: 'mwebb@crm.mail', rep: 'Marcus', state: 'ready', sentToday: 0, limit: 300, lastSend: ago(1500), error: '' },
      { id: 'e3', name: 'sam@crm.mail', rep: 'Sam', state: 'ready', sentToday: 118, limit: 400, lastSend: ago(15), error: '' },
      { id: 'e4', name: 'sarah.lane@crm.mail', rep: 'Sarah', state: 'paused', sentToday: 0, limit: 300, lastSend: ago(2900), error: 'Paused by an admin' },
      { id: 'e5', name: 'mike.ortiz@crm.mail', rep: 'Mike', state: 'error', sentToday: 0, limit: 300, lastSend: ago(4400), error: 'Sign-in expired. Reconnect the account.' }
    ],
    sms: [
      { id: 's1', name: 'iPhone 1', number: '3055550101', rep: 'Marcus', state: 'ready', sentToday: 23, limit: 150, lastSend: ago(9), heartbeat: ago(1), error: '' },
      { id: 's2', name: 'iPhone 2', number: '3055550102', rep: 'Sam', state: 'ready', sentToday: 61, limit: 150, lastSend: ago(4), heartbeat: ago(1), error: '' },
      { id: 's3', name: 'iPhone 3', number: '3055550103', rep: 'Sarah', state: 'ready', sentToday: 12, limit: 150, lastSend: ago(200), heartbeat: ago(190), error: '' },
      { id: 's4', name: 'iPhone 4', number: '3055550104', rep: 'Mike', state: 'ready', sentToday: 150, limit: 150, lastSend: ago(40), heartbeat: ago(1), error: '' }
    ]
  },
  // Text templates. Campaigns fill in {first}, {last}, {company} and {rep}.
  smsTemplates: [
    { id: 'sms-01', name: 'SMS Intro 01', body: 'Hi {first}, this is {rep} with CRM. We help businesses like {company} get working capital fast. Open to a quick call this week?' },
    { id: 'sms-04', name: 'SMS Follow Up 04', body: 'Hi {first}, {rep} here. Just checking in. Is funding still on your list for {company}?' }
  ],

  // ── SAMPLE SENDING SERVICE ──
  // Stands in for the real sending service so Live and Results can be tried. It sends nothing to anyone.
  // It works each sender's queue on the campaign's own pacing, but 10× faster, and makes up plausible results:
  // most messages go out, a few fail, and some get opens, replies, unsubscribes or STOPs.
  // It reports everything through the Campaign page's api (see the top of camp.js).
  campaignEngine: api => {
    const SPEED = 10;
    let loop = 0;
    const between = (a, b) => a + Math.random() * (b - a);
    const gap = p => Math.max(p.delay === 'range' ? between(p.min, p.max) : p.min, 3600 / p.hourly) * 1000 / SPEED;
    const later = (seconds, fn) => setTimeout(fn, seconds * 1000);
    function followUp(m, type) {
      if (type === 'sms' && Math.random() < 0.9) later(between(1, 3), () => api.message(m.id, { state: 'delivered' }));
      if (type === 'email' && Math.random() < 0.45) later(between(2, 8), () => api.response(m.id, 'opened'));
      const roll = Math.random();
      if (roll < 0.12) later(between(5, 15), () => api.response(m.id, 'reply'));
      else if (roll < 0.16) later(between(4, 12), () => api.response(m.id, type === 'sms' ? 'stop' : 'unsubscribed'));
    }
    function step() {
      const r = api.record();
      if (!r) { clearInterval(loop); loop = 0; return; }
      const now = Date.now(), p = r.snapshot.channel.protection;
      if (r.status === 'scheduled') { if (now >= r.scheduledFor) api.setStatus('running'); return; }
      if (r.status !== 'running') return;
      if (!api.remaining()) { api.setStatus('completed'); return; }
      let failedNow = false;
      r.snapshot.senders.forEach(s => {
        const st = r.senders[s.id] || {}, sent = st.sent || 0;
        if (st.state === 'paused' || st.state === 'limit' || now < (st.nextAt || 0)) return;
        if (s.sentToday + sent >= s.limit) { api.sender(s.id, { state: 'limit', nextAt: 0, note: 'Daily limit reached' }); return; }
        const m = api.nextFor(s.id);
        if (!m) { if (st.state !== 'idle') api.sender(s.id, { state: 'idle', nextAt: 0, note: 'Nothing left to send' }); return; }
        if (p.windowOn && !api.inWindow(m)) { api.sender(s.id, { state: 'waiting', nextAt: now + 30000, note: 'Outside the send window' }); return; }
        const roll = Math.random(), limited = r.type === 'email' && roll < 0.03, failed = !limited && roll < 0.08;
        let next = now + gap(p), state = 'ready', note = '', fails = st.fails || 0;
        if (limited) {
          api.event('throttled', s.id, p.autoSlow ? 'provider rate limit, slowing down' : 'provider rate limit');
          if (p.autoSlow) next = now + gap(p) * 3;
        } else if (failed) {
          fails += 1;
          failedNow = true;
          const reason = r.type === 'sms' ? 'carrier rejected the message' : 'mailbox does not exist';
          api.message(m.id, { state: m.attempts < p.retries ? 'queued' : 'failed', reason });
        } else {
          fails = 0;
          api.message(m.id, { state: 'sent' });
          followUp(m, r.type);
        }
        const tries = limited ? sent : sent + 1;
        if (p.delay === 'batch' && !limited && tries % p.batchSize === 0) { next = now + p.batchWait * 60000 / SPEED; state = 'cooldown'; note = 'Batch complete'; }
        if (p.pauseAfter && fails >= p.pauseAfter) { state = 'paused'; note = `${fails} failures in a row`; api.event('paused', s.id, note); }
        api.sender(s.id, { state, nextAt: state === 'paused' ? 0 : next, note, sent: tries, fails });
      });
      const done = r.messages.filter(m => m.state === 'sent' || m.state === 'delivered' || m.state === 'failed');
      const rate = done.length ? done.filter(m => m.state === 'failed').length * 100 / done.length : 0;
      if (failedNow && done.length >= 10 && rate > p.pauseRate) api.setStatus('paused', `${Math.round(rate)}% of sends failed`);
    }
    return {
      start() { if (!loop) loop = setInterval(step, 250); },
      pause() { api.setStatus('paused', 'paused by you'); },
      resume() { api.setStatus('running'); },
      stop() { api.setStatus('stopped'); },
      pauseSender(id) { api.sender(id, { state: 'paused', nextAt: 0, note: 'Paused by you' }); },
      resumeSender(id) { api.sender(id, { state: 'ready', nextAt: 0, note: '', fails: 0 }); }
    };
  }
};
