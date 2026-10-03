// ── SOUNDS ──
// Every sound is made here in the browser (Web Audio), so there are no sound files to load.
// The dialer uses real phone tones: keypad tones (DTMF), the US ringback while a call rings, and a short tone when a
// call ends. An incoming call rings with a soft chime. New texts and WhatsApp messages, new email and other alerts
// (missed calls, email opens, reminders, campaign replies) each have their own short chime.
// Settings › Sounds sets the volume and turns each group on or off (kept in this browser as nv.sounds).
// Browsers keep a page silent until the first click or key press, so sounds start after that.
const sounds = (() => {
  const GROUPS = ['dialer', 'messages', 'emails', 'alerts'];
  const settings = { volume: 70, dialer: true, messages: true, emails: true, alerts: true, ...store.read('nv.sounds', {}) };
  let ctx = null, master = null, loopTimer = 0, looping = '';

  function unlock() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.connect(ctx.destination);
      setVolume();
    }
    if (ctx.state === 'suspended') ctx.resume();
  }
  addEventListener('pointerdown', unlock, true);
  addEventListener('keydown', unlock, true);
  function setVolume() { if (master) master.gain.value = settings.volume / 100 * 0.8; }

  // A steady tone of one or more frequencies (phone tones), with soft edges so it never clicks.
  function tone(freqs, at, length, level = 0.14) {
    const t = ctx.currentTime + at, g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.setValueAtTime(level, t + length - 0.02);
    g.gain.linearRampToValueAtTime(0, t + length);
    g.connect(master);
    freqs.forEach(f => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + length + 0.02); });
  }
  // A bell-like note that fades out (chimes).
  function bell(freq, at, length = 0.6, level = 0.22) {
    const t = ctx.currentTime + at, g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + length);
    g.connect(master);
    [[freq, 1], [freq * 2, 0.25]].forEach(([f, share]) => {
      const o = ctx.createOscillator(), s = ctx.createGain();
      o.frequency.value = f;
      s.gain.value = share;
      o.connect(s).connect(g);
      o.start(t);
      o.stop(t + length + 0.02);
    });
  }

  const DTMF = { 1: [697, 1209], 2: [697, 1336], 3: [697, 1477], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
    7: [852, 1209], 8: [852, 1336], 9: [852, 1477], '*': [941, 1209], 0: [941, 1336], '#': [941, 1477] };
  // Each sound: its group, how to play it, and for the two that repeat, how often (ms).
  const SOUNDS = {
    ringback: { group: 'dialer', every: 6000, play: () => tone([440, 480], 0, 2, 0.1) },
    ring: { group: 'dialer', every: 3000, play: () => { bell(1319, 0); bell(1047, 0.18); bell(1319, 0.5); bell(1047, 0.68); } },
    end: { group: 'dialer', play: () => { tone([480, 620], 0, 0.18, 0.1); tone([480, 620], 0.3, 0.18, 0.1); } },
    message: { group: 'messages', play: () => { bell(1319, 0, 0.35); bell(1760, 0.11, 0.5); } },
    email: { group: 'emails', play: () => { bell(784, 0, 0.5); bell(1175, 0.16, 0.7); } },
    alert: { group: 'alerts', play: () => { bell(988, 0, 0.4); bell(1319, 0.12, 0.4); bell(1568, 0.24, 0.6); } }
  };
  const ready = group => ctx && ctx.state === 'running' && settings[group] && settings.volume > 0;

  function play(name) { const s = SOUNDS[name]; if (ready(s.group)) s.play(); }
  function key(k) { if (DTMF[k] && ready('dialer')) tone(DTMF[k], 0, 0.12); }
  // A sound that repeats until stop(): ringback while a call rings, the ring of an incoming call.
  function loop(name) {
    stop();
    looping = name;
    play(name);
    loopTimer = setInterval(() => play(name), SOUNDS[name].every);
  }
  function stop() { clearInterval(loopTimer); looping = ''; }
  // New alerts (notify()): texts and WhatsApp, email, or everything else.
  const notice = kind => play(kind === 'sms' || kind === 'wa' ? 'message' : kind === 'email' ? 'email' : 'alert');

  // Settings › Sounds. A change plays a sample so it can be heard.
  const SAMPLE = { dialer: () => key(5), messages: () => play('message'), emails: () => play('email'), alerts: () => play('alert') };
  function set(changes) {
    Object.assign(settings, changes);
    store.write('nv.sounds', settings);
    setVolume();
    if (looping && !settings[SOUNDS[looping].group]) stop();
  }
  return { GROUPS, settings, play, key, loop, stop, notice, set, sample: group => SAMPLE[group]() };
})();
