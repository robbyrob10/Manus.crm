// ── PHONE ENGINE ──
// The only part that talks to phones. Every screen below calls these methods and listens for changes.
// This version is a stand-in: it pretends the other side answers after 2.2 seconds and never reaches a real phone.
// To connect a real phone system, replace this block and keep the same method names.
// receiveCall(number) is the entry point the real system uses to announce an incoming call.
// The phone in use is remembered in this browser, and cannot change during a call.
const phoneEngine = (() => {
  const phones = [{ id: 'p1', name: 'Phone 1', connected: true }, { id: 'p2', name: 'Phone 2', connected: true }];
  const saved = store.read('nv.phone', '');
  const state = { phase: 'idle', number: '', muted: false, held: false, speaker: false, phoneId: phones.some(p => p.id === saved) ? saved : phones[0].id, connectedAt: 0, tones: '', note: '', transferredTo: '', party: null };
  const listeners = new Set();
  let ringTimer = 0, partyTimer = 0;

  const emit = () => listeners.forEach(fn => fn());
  const activePhone = () => phones.find(p => p.id === state.phoneId);
  const connect = () => { state.phase = 'active'; state.connectedAt = Date.now(); emit(); };
  const reset = (transferredTo = '') => {
    clearTimeout(ringTimer); clearTimeout(partyTimer);
    Object.assign(state, { phase: 'idle', number: '', muted: false, held: false, speaker: false, connectedAt: 0, tones: '', note: '', transferredTo, party: null });
    emit();
  };

  return {
    state, phones, activePhone,
    subscribe(fn) { listeners.add(fn); },
    dial(number) {
      if (state.phase !== 'idle') return;
      number = number.trim();
      if (!number) { state.note = 'Enter a number'; emit(); return; }
      if (!activePhone().connected) { state.note = `${activePhone().name} is not connected`; emit(); return; }
      Object.assign(state, { phase: 'dialing', number, note: '', transferredTo: '' });
      ringTimer = setTimeout(connect, 2200);
      emit();
    },
    receiveCall(number) {
      if (state.phase !== 'idle') return;
      Object.assign(state, { phase: 'incoming', number, note: '', transferredTo: '' });
      emit();
    },
    answer() { if (state.phase === 'incoming') connect(); },
    end() { if (state.phase !== 'idle') reset(); },
    setMuted(on) { state.muted = on; emit(); },
    setHeld(on) { state.held = on; emit(); },
    setSpeaker(on) { state.speaker = on; emit(); },
    sendTone(key) { if (state.phase === 'active') { state.tones += key; emit(); } },
    transfer(number) { number = number.trim(); if (state.phase === 'active' && number) reset(number); },
    addParty(number) {
      number = number.trim();
      if (state.phase !== 'active' || state.party || !number) return;
      state.held = true;
      state.party = { number, connected: false, merged: false };
      partyTimer = setTimeout(() => { state.party.connected = true; emit(); }, 2200);
      emit();
    },
    merge() {
      const p = state.party;
      if (p && p.connected && !p.merged) { p.merged = true; state.held = false; emit(); }
    },
    selectPhone(id) {
      if (state.phase !== 'idle' || !phones.some(p => p.id === id)) return;
      state.phoneId = id;
      store.write('nv.phone', id);
      emit();
    },
    // rep: whose phone line the message goes out on (the lead's rep). The real phone system sends from that rep's line.
    sendMessage(number, text, rep) {
      const phone = activePhone();
      return phone.connected ? { phone: phone.name, at: Date.now() } : null;
    }
  };
})();


// ── DIALER SCREEN ──
// A dark card (the sidebar colour) that floats over the page. One row while idle: who, the number, and one round button —
// green Call, which turns into red End in the same spot. An incoming call shows green Answer and red Decline side by side.
// During a call Mute, Hold and Speaker stay visible; Transfer and Add participant are in More.
// The round phone icon's colour matches the phone button in the topbar: green ready or in a call, amber ringing or on
// hold, grey no phone.
const dialer = $('dialer'), dialInput = $('dialInput'), callBtn = $('callBtn'), declineBtn = $('declineBtn'), root = document.documentElement;
const dialMore = $('dialMore'), dialMoreSummary = dialMore.querySelector('summary');
let entry = null; // null, 'transfer' or 'add'
let prevPhase = 'idle';
let keypadOpen = false;
let dialerOpen = false;
let hint = '';
let hintTimer = 0;

function statusText(s, phone) {
  if (s.phase === 'idle') return s.note || (s.transferredTo ? 'Transferred to ' + fmtPhone(s.transferredTo) : phone.connected ? `${phone.name} · Ready` : `${phone.name} · Not connected`);
  if (s.phase === 'dialing') return `Ringing · ${phone.name}`;
  if (s.phase === 'incoming') return `Incoming · ${phone.name}`;
  if (s.party) return s.party.merged ? `Conference · 2 people` : s.party.connected ? `Second call · Connected` : `Calling second number…`;
  return s.held ? `On hold · ${phone.name}` : `Connected · ${phone.name}`;
}
const toneOf = (s, phone) => s.phase === 'incoming' || s.phase === 'dialing' || (s.phase === 'active' && s.held) ? 'wait'
  : s.phase === 'active' || phone.connected ? 'live' : 'off';

function updateTimer() {
  const s = phoneEngine.state;
  let text = '';
  if (s.phase === 'active') {
    const sec = Math.floor((Date.now() - s.connectedAt) / 1000);
    text = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }
  $('dialerTimer').textContent = $('phoneTime').textContent = text;
}

function setControl(name, { on, label }) {
  const btn = dialer.querySelector(`[data-ctl="${name}"]`);
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on);
  if (label) btn.querySelector('.dial-ctrl-label').textContent = label;
}

function setLabel(el, text) { el.title = text; el.setAttribute('aria-label', text); }

function showHint(text) {
  hint = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint = ''; renderDialer(); }, 1800);
  renderDialer();
}

// Opens or closes the call controls, which fold open below the first row.
function setFold(el, on) {
  el.classList.toggle('open', on);
  el.inert = !on;
}

function renderDialer() {
  const s = phoneEngine.state, idle = s.phase === 'idle', active = s.phase === 'active', phone = phoneEngine.activePhone();
  const lead = leadByNumber(idle ? dialInput.value : s.number), tone = toneOf(s, phone);
  const name = lead ? fullName(lead)
    : idle ? (dialInput.value.trim() ? 'New number' : 'Enter a number')
    : s.phase === 'incoming' ? 'Unknown caller' : fmtPhone(s.number);
  const face = $('dialerAvatar');
  face.hidden = !lead;
  face.textContent = lead ? `${(lead.first || name)[0] || ''}${(lead.last || '')[0] || ''}`.toUpperCase() : '';
  $('dialerName').textContent = name;
  $('dialerName').title = lead ? `${name} · ${lead.company}` : name;
  const status = $('dialerStatus');
  status.textContent = hint || statusText(s, phone);
  status.classList.toggle('warn', !!hint || (idle && !phone.connected));
  for (const el of [dialer, $('phoneCtl')]) { el.dataset.state = s.phase; el.dataset.tone = tone; }

  const canEdit = idle || entry !== null;
  dialInput.readOnly = !canEdit;
  dialInput.placeholder = entry === 'transfer' ? 'Transfer to…' : entry === 'add' ? 'Number to add…' : idle ? 'Enter number…' : fmtPhone(s.number);
  if (!canEdit) dialInput.value = fmtPhone(s.number);
  else {
    // A typed number shows as (305) 555-5555 as soon as all 10 digits are in; until then, the digits as typed.
    const shown = fmtPhone(dialInput.value.replace(/[^\d*#+]/g, ''));
    if (shown !== dialInput.value) dialInput.value = shown;
  }

  // One round button: Call, then End in the same spot. A second one only when there is a choice to make.
  const ends = entry === null && (s.phase === 'dialing' || active);
  const callText = entry === 'transfer' ? 'Transfer' : entry === 'add' ? 'Call and add' : s.phase === 'incoming' ? 'Answer' : ends ? 'End call' : 'Call';
  callBtn.classList.toggle('end', ends);
  setLabel(callBtn, entry === 'transfer' ? 'Transfer to this number' : callText);
  $('callVisibleLabel').textContent = callText;
  const showDecline = s.phase === 'incoming' || entry !== null;
  declineBtn.hidden = !showDecline;
  $('declineAction').hidden = !showDecline;
  const declineText = s.phase === 'incoming' ? 'Decline' : entry === 'transfer' ? 'Cancel transfer' : 'Cancel adding a call';
  setLabel(declineBtn, declineText);
  $('declineVisibleLabel').textContent = declineText;

  setControl('mute', { on: s.muted });
  setControl('hold', { on: s.held });
  setControl('speaker', { on: s.speaker });
  setControl('transfer', { on: entry === 'transfer' });
  setControl('add', { on: entry === 'add', label: s.party && s.party.connected && !s.party.merged ? 'Merge' : 'Add' });
  setFold($('dialCtrlsWrap'), active);
  fitLcd();

  $('phoneName').textContent = phone.name;
  setLabel($('phonePick'), `${phone.name}, ${phone.connected ? 'connected' : 'not connected'}. Choose phone`);
  setLabel($('phoneOpen'), s.phase === 'incoming' ? 'Incoming call. Open dialer' : dialerOpen ? 'Minimize dialer' : 'Open dialer');
  updateTimer();
}

function fitLcd() {
  const sample = '(646) 555-0191';
  const text = dialInput.value || sample;
  const canvas = fitLcd.canvas || (fitLcd.canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  const cs = getComputedStyle(dialInput);
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const pad = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
    .reduce((sum, prop) => sum + (parseFloat(cs[prop]) || 0), 0);
  dialInput.style.width = Math.ceil(ctx.measureText(text).width) + pad + 'px';
}

function setKeypad(on) {
  const kp = $('keypadPop');
  keypadOpen = on;
  kp.classList.toggle('open', on);
  kp.inert = !on;
  $('keypadBtn').classList.toggle('active', on);
  $('keypadBtn').setAttribute('aria-expanded', on);
  if (on) placeDialer();
  banners.place();
}

function setOpen(on) {
  if (!on) {
    setKeypad(false);
    if (dialer.contains(document.activeElement)) $('phoneOpen').focus();
  }
  dialerOpen = on;
  dialer.classList.toggle('open', on);
  dialer.inert = !on;
  $('phoneOpen').setAttribute('aria-expanded', on);
  $('dialerToggle').classList.toggle('on', on);
  if (on) placeDialer();
  renderDialer();
  banners.place();
}

// The phone choices, for the phone switch in the topbar and the phone button in Panel 3.
function phoneItems() {
  if (phoneEngine.state.phase !== 'idle') return [{ label: 'The phone can’t change during a call' }];
  return phoneEngine.phones.map(p => ({ label: `${p.name} · ${p.connected ? 'Connected' : 'Not connected'}`, cls: p.id === phoneEngine.state.phoneId ? 'selected' : '', run: () => phoneEngine.selectPhone(p.id) }));
}

function prefillDialer() {
  if (phoneEngine.state.phase === 'idle' && entry === null) {
    dialInput.value = currentLead() ? fmtPhone(actTarget('call', currentLead())) : '';
  }
}

function showNumber(number) {
  if (phoneEngine.state.phase === 'idle') { dialInput.value = fmtPhone(number); renderDialer(); }
  setOpen(true);
}

// SMS and WhatsApp open in Communications, not as a call draft in the Dialer.
function clearDialerDraft() {
  if (phoneEngine.state.phase !== 'idle' || entry !== null) return;
  dialInput.value = '';
  renderDialer();
}

function callNumber(number) {
  showNumber(number);
  if (!number) { dialInput.focus(); return; }
  if (phoneEngine.state.phase === 'idle') phoneEngine.dial(toDial(number));
}

// Enter and the green button: confirm a transfer or added call, call the number, or answer. Never ends a call.
function callOrAnswer() {
  const phase = phoneEngine.state.phase;
  if (entry !== null) confirmEntry();
  else if (phase === 'idle') phoneEngine.dial(toDial(dialInput.value));
  else if (phase === 'incoming') phoneEngine.answer();
}

function confirmEntry() {
  const value = dialInput.value.trim();
  if (!value) return;
  if (entry === 'transfer') phoneEngine.transfer(toDial(value)); else phoneEngine.addParty(toDial(value));
  entry = null;
  renderDialer();
}

function startEntry(mode) {
  entry = entry === mode ? null : mode;
  dialInput.value = '';
  renderDialer();
  if (entry) dialInput.focus();
}

function pressKey(key) {
  const phase = phoneEngine.state.phase;
  if (phase === 'active' && entry === null) { sounds.key(key); phoneEngine.sendTone(key); }
  else if (phase === 'idle' || entry !== null) { sounds.key(key); dialInput.value += key; renderDialer(); }
  else showHint('Keypad is off while ringing');
}

$('keypadPop').addEventListener('click', e => {
  const key = e.target.closest('[data-key]');
  if (key) pressKey(key.dataset.key);
});

$('dialCtrls').addEventListener('click', e => {
  const btn = e.target.closest('[data-ctl]');
  if (!btn) return;
  const s = phoneEngine.state;
  switch (btn.dataset.ctl) {
    case 'mute': phoneEngine.setMuted(!s.muted); break;
    case 'hold': phoneEngine.setHeld(!s.held); break;
    case 'speaker': phoneEngine.setSpeaker(!s.speaker); break;
    case 'transfer': startEntry('transfer'); break;
    case 'add':
      if (!s.party) startEntry('add');
      else if (!s.party.connected) showHint('Second call is still ringing');
      else if (!s.party.merged) phoneEngine.merge();
      else showHint('Calls are already merged');
      break;
  }
  if (btn.closest('#dialMoreMenu')) {
    dialMore.open = false;
    if (entry !== null) dialInput.focus(); else dialMoreSummary.focus();
  }
});

dialMore.addEventListener('toggle', () => dialMoreSummary.setAttribute('aria-expanded', String(dialMore.open)));

$('keypadBtn').addEventListener('click', () => setKeypad(!keypadOpen));
callBtn.addEventListener('click', () => { if (callBtn.classList.contains('end')) phoneEngine.end(); else callOrAnswer(); });
declineBtn.addEventListener('click', () => {
  if (entry !== null) { entry = null; renderDialer(); } else phoneEngine.end();
});
$('dialerMin').addEventListener('click', () => setOpen(false));
$('phoneOpen').addEventListener('click', () => setOpen(!dialerOpen));
$('phonePick').addEventListener('click', () => {
  const anchor = $('phonePick');
  if (popAnchor === anchor) closePop(); else openPop(anchor, phoneItems(), { list: true });
});

dialInput.addEventListener('input', renderDialer);
dialInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (entry !== null) confirmEntry();
  else if (phoneEngine.state.phase === 'idle') phoneEngine.dial(toDial(dialInput.value));
});
document.addEventListener('pointerdown', e => {
  if (dialMore.open && !dialMore.contains(e.target)) dialMore.open = false;
  if (popAnchor && !e.target.closest('#pop, [data-pop], [data-pick], [aria-haspopup="menu"]')) closePop();
  if (notifOpen && !e.target.closest('.notif')) setNotif(false);
});

// ── DIALER KEYS ──
// While the dialer is open: number keys (top row or number pad), * and # type the number — or press keypad tones during a
// call — Backspace erases the last digit, Enter calls (or answers), and pasting a number fills it in.
// None of this happens while typing in another box. Enter works from the page, the dialer itself and the keypad;
// on any other button Enter still presses that button.
const typingIn = el => el.closest('input, textarea, select, [contenteditable="true"]');
const NUMPAD = { Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4', Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9', NumpadMultiply: '*' };
const canEditNumber = () => phoneEngine.state.phase === 'idle' || entry !== null;
document.addEventListener('keydown', e => {
  if (!dialerOpen || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
  const key = NUMPAD[e.code] || (/^[0-9*#]$/.test(e.key) ? e.key : '');
  if (key) { e.preventDefault(); pressKey(key); }
  else if (e.key === 'Backspace' && canEditNumber()) {
    e.preventDefault();
    dialInput.value = dialInput.value.replace(/[^\d*#]*[\d*#][^\d*#]*$/, '');
    renderDialer();
  } else if (e.key === 'Enter' && (e.target === document.body || e.target === dialer || e.target.closest('#keypadPop, #keypadBtn'))) {
    e.preventDefault();
    callOrAnswer();
  }
});
document.addEventListener('paste', e => {
  if (!dialerOpen || (typingIn(e.target) && e.target !== dialInput) || !canEditNumber()) return;
  const digits = digitsOf(e.clipboardData.getData('text'));
  if (!digits) return;
  e.preventDefault();
  dialInput.value = fmtPhone(digits);
  renderDialer();
});

// Each finished call is added to that lead's activity feed, and to the work log of the rep who took or made it.
let callLog = null;
function logCall({ number, incoming, connectedAt }) {
  const lead = leadByNumber(number), digits = digitsOf(number);
  const sec = connectedAt ? Math.floor((Date.now() - connectedAt) / 1000) : 0;
  const dir = incoming ? (connectedAt ? 'in' : 'missed') : 'out';
  const num = digits.length >= 10 ? digits.slice(-10) : number, leadId = lead ? lead.id : null;
  calls.push({ id: 'c' + Date.now(), number: num, leadId, rep: lead ? lead.rep : user.name, by: user.name, dir, at: Date.now(), seconds: sec, phone: phoneEngine.activePhone().name, seen: true });
  workLog.add('call', { leadId, number: num, dir, secs: sec });
  renderComms();
  if (!lead) return;
  const length = fmtDuration(sec);
  logActivity(lead.id, 'call', incoming
    ? (connectedAt ? `Call from ${fmtPhone(number)} · ${length}` : `Declined call from ${fmtPhone(number)}`)
    : (connectedAt ? `Call to ${fmtPhone(number)} · ${length}` : `Call to ${fmtPhone(number)} · no answer`));
}


// Ringback while an outgoing call rings, a ring for an incoming one, a short tone when a call ends.
// A call going out or being answered makes sure the microphone may be used.
function callSound(phase, before) {
  if (phase === 'dialing') sounds.loop('ringback');
  else if (phase === 'incoming') sounds.loop('ring');
  else sounds.stop();
  if (phase === 'idle' && before !== 'idle') sounds.play('end');
  if (phase === 'dialing' || (phase === 'active' && before === 'incoming')) microphone.check();
}

// ── MICROPHONE ──
// A call needs the microphone. It is asked for once, on the first call made or answered, never when the page opens.
// The browser remembers the answer when the CRM runs from a web address (https) or as the desktop app; opened
// straight from a file on the computer, the browser may ask again next time. Nothing is recorded: the stand-in phone
// engine does not use the sound yet, so the microphone is let go at once. A real phone system keeps it during the call.
const microphone = (() => {
  let asked = false;
  async function check() {
    if (asked) return;
    asked = true;
    if (!navigator.mediaDevices) { toast('This browser can’t use a microphone here.', [], 8000); return; }
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); }
    catch { toast('The microphone is blocked, so the other person can’t hear you. Allow it in the browser’s site settings.', [], 8000); }
  }
  return { check };
})();

phoneEngine.subscribe(() => {
  const s = phoneEngine.state, phase = s.phase;
  if (phase !== 'idle' && prevPhase === 'idle') { callLog = { number: s.number, incoming: phase === 'incoming', connectedAt: 0 }; banners.clear(); }
  if (phase === 'active' && callLog && !callLog.connectedAt) callLog.connectedAt = s.connectedAt;
  if (phase === 'idle' && callLog) { logCall(callLog); callLog = null; }
  if (phase === 'incoming' && prevPhase !== 'incoming') setOpen(true);
  if (phase !== 'active') entry = null;
  if (phase === 'idle' && prevPhase !== 'idle') prefillDialer();
  if (phase !== prevPhase) { hint = ''; clearTimeout(hintTimer); callSound(phase, prevPhase); }
  prevPhase = phase;
  renderDialer();
  updatePhoneBtn();
  renderTitle();
});
setInterval(updateTimer, 1000);


// ── DIALER POSITION ──
// Drag the dialer from anywhere on it except the number box. A short press on a button is still a click; moving
// more than a few pixels makes it a drag, and that button does not fire. With the dialer itself selected, the arrow
// keys move it (Shift for bigger steps). Each time it opens it sits at the bottom middle of the Leads page's middle
// panel (on other pages, the bottom middle of the page), and it stays where it is dropped until it is minimized.
// It can be dragged anywhere on the screen, including over the top bar.
const EDGE = 8, DRAG_START = 5;
let dialerPos = null;
let drag = null, justDragged = false;

function homeSpot() {
  const area = (page === 'leads' ? document.querySelector('.panel-detail') : $(page + 'Page')).getBoundingClientRect();
  return { x: area.left + (area.width - dialer.offsetWidth) / 2, y: area.bottom - dialer.offsetHeight - EDGE };
}
function placeDialer() {
  const want = dialerPos || homeSpot();
  const at = { x: clamp(want.x, 0, innerWidth - dialer.offsetWidth), y: clamp(want.y, 0, innerHeight - dialer.offsetHeight) };
  dialer.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
  if (keypadOpen) placeKeypad(at, EDGE);
  return at;
}
// The keypad opens under the dialer, lined up with its button. When there is more room above than below and it does
// not fit below, it opens above instead. It always stays fully on screen, left to right.
function placeKeypad(at, top) {
  const kp = $('keypadPop'), key = $('keypadBtn'), need = kp.offsetHeight + 6 * remPx() / 16;
  const below = innerHeight - EDGE - (at.y + dialer.offsetHeight), above = at.y - top;
  kp.classList.toggle('up', below < need && above > below);
  const left = key.offsetLeft + key.offsetWidth / 2 - kp.offsetWidth / 2;
  kp.style.left = clamp(left, EDGE - at.x, innerWidth - EDGE - kp.offsetWidth - at.x) + 'px';
}
// The part of the screen the dialer covers, with its keypad when that is open. Banners keep out of it.
function dialerBox() {
  const d = dialer.getBoundingClientRect();
  if (!keypadOpen) return d;
  const k = $('keypadPop').getBoundingClientRect();
  return { left: Math.min(d.left, k.left), right: Math.max(d.right, k.right), top: Math.min(d.top, k.top), bottom: Math.max(d.bottom, k.bottom) };
}
function moveDialer(x, y) {
  dialerPos = { x, y };
  dialerPos = placeDialer();
  banners.place();
}

dialer.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target === dialInput) return;
  const r = dialer.getBoundingClientRect();
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moving: false };
  addEventListener('pointermove', onDrag);
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);
});
function onDrag(e) {
  if (e.pointerId !== drag.id) return;
  if (!drag.moving) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_START) return;
    drag.moving = true;
    dialer.classList.add('dragging');
  }
  moveDialer(e.clientX - drag.dx, e.clientY - drag.dy);
}
function endDrag(e) {
  if (e.pointerId !== drag.id) return;
  removeEventListener('pointermove', onDrag);
  removeEventListener('pointerup', endDrag);
  removeEventListener('pointercancel', endDrag);
  if (drag.moving) {
    dialer.classList.remove('dragging');
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
  }
  drag = null;
}
// A drag that ends on a button is not a click.
dialer.addEventListener('click', e => { if (justDragged) { e.stopPropagation(); e.preventDefault(); } }, true);

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
dialer.addEventListener('keydown', e => {
  if (e.target !== dialer || !ARROWS[e.key]) return;
  e.preventDefault();
  const step = e.shiftKey ? 40 : 10, at = placeDialer(), [dx, dy] = ARROWS[e.key];
  moveDialer(at.x + dx * step, at.y + dy * step);
});

addEventListener('resize', placeDialer);
new ResizeObserver(() => { placeDialer(); banners.place(); }).observe(dialer);


// ── START ──
renderSidebarUser();
renderLeads();
renderDetail();
renderComms();
mail.mount($('mailHostComms'), 'compact');
mail.ready.then(() => { buildNotifications(); renderNotifs(); });
prefillDialer();
setOpen(false);
requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('still')));
