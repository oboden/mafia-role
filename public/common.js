// Shared bits for every page.
window.Mafia = (() => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ROLES = {
    mafia: { name: 'Mafia', desc: 'Each night, agree with the other Mafia on someone to eliminate. By day, blend in.' },
    doctor: { name: 'Doctor', desc: 'Each night, point at one person to save. If the Mafia chose them, they live.' },
    villager: { name: 'Villager', desc: 'Find the Mafia. Argue, accuse and vote them out before they outnumber you.' },
  };

  function masthead(left, right) {
    return `<header class="masthead">
      <div class="rule"></div>
      <div class="meta"><span>${esc(left)}</span><span>${esc(right)}</span></div>
      <p class="title">The Mafia Daily</p>
      <div class="rule thin"></div><div class="rule"></div>
    </header>`;
  }

  // Stepper buttons: any [data-step="+1|-1"] next to an input in a .stepper.
  function wireSteppers(root, onChange) {
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-step]');
      if (!b) return;
      const input = b.closest('.stepper').querySelector('input');
      const min = Number(input.min || 0), max = Number(input.max || 99);
      const next = Math.min(max, Math.max(min, (parseInt(input.value, 10) || 0) + Number(b.dataset.step)));
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (onChange) onChange(input);
    });
  }

  // Artwork dropped into public/illustrations (the server lists what's there).
  let artList = null;
  function artFiles() {
    if (!artList) artList = fetch('/api/art').then((r) => r.json()).then((d) => d.files || []).catch(() => []);
    return artList;
  }

  // Fill the card's illustration slot with public/illustrations/<role>.png
  // (or .webp/.gif/.svg/.jpg) once it exists; until then the slot stays empty.
  async function illustration(el, role) {
    el.classList.remove('has-art');
    el.style.backgroundImage = '';
    const files = await artFiles();
    const file = ['png', 'webp', 'gif', 'svg', 'jpg', 'jpeg'].map((x) => `${role}.${x}`).find((f) => files.includes(f));
    if (!file) return;
    el.style.backgroundImage = `url(/illustrations/${file})`;
    el.classList.add('has-art');
  }

  // ---- Haptics when a player peeks at their role ----
  // EDIT HERE to design the feel of each role. Numbers are milliseconds:
  // buzz, pause, buzz, pause... (Android phones; iPhones only get TICKS below).
  // Placeholder rhythms: Mafia a heavy heartbeat, Doctor a light flutter, Villager one calm pulse.
  // Tip: keep every pattern the same total length with the same amount of buzzing,
  // or people nearby can hear who's who. The browser test warns if they differ.
  const PATTERNS = {
    mafia: [110, 80, 130, 380],
    doctor: [60, 60, 60, 60, 60, 60, 60, 280],
    villager: [240, 460],
  };
  // While the player holds the card: short pulses that start far apart and get
  // longer and closer together, like a heartbeat speeding up. Identical for every
  // role, so it gives nothing away. Cancelled if they let go early.
  function buildUpPattern(ms) {
    const pattern = [];
    let t = 0;
    for (let i = 0; t < ms; i++) {
      const f = t / ms;                         // 0 → 1 through the hold
      const on = Math.round(18 + f * 50);       // pulses grow from 18 ms to ~68 ms
      const off = Math.round(170 - f * 150);    // gaps shrink from 170 ms to ~20 ms
      pattern.push(on, off);
      t += on + off;
    }
    return pattern;
  }

  // iPhones can't vibrate from a web page at all (an Apple restriction). The one
  // thing recent iOS Safari does is a light system tick when a switch is toggled
  // during a real tap, so we try that once when the press starts. A build-up on
  // iPhone needs the app wrapped as a native app.
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function iosTick() {
    try {
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      label.appendChild(input);
      document.body.appendChild(label);
      label.click();
      label.remove();
    } catch { /* not supported */ }
  }
  // ---- Sound ----
  // Files in public/sounds (mp3, m4a, ogg or wav):
  //   buildup.*   plays while the player holds the card
  //   reveal.*    plays when the card opens
  // Every role hears exactly the same two sounds, so nobody at the table can tell who's who.
  // Until files are added, quiet placeholder tones are synthesised so the timing can be tested.
  // Phones only allow sound after the player has tapped the page, so unlock() runs on taps.
  const sound = (() => {
    let ctx = null;
    let files = null;
    const buffers = {};
    const list = () => (files ||= fetch('/api/sounds').then((r) => r.json()).then((d) => d.files || []).catch(() => []));
    function unlock() {
      try {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
      } catch { /* no audio */ }
    }
    async function load(name) {
      const all = await list();
      const file = ['mp3', 'm4a', 'ogg', 'wav'].map((x) => `${name}.${x}`).find((f) => all.includes(f));
      if (!file || !ctx) return null;
      buffers[file] ||= fetch(`/sounds/${file}`).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).catch(() => null);
      return buffers[file];
    }
    function output(volume) {
      const g = ctx.createGain();
      g.gain.value = volume;
      g.connect(ctx.destination);
      return g;
    }
    // Placeholder tones
    function synthBuildUp(ms, volume) {
      const t = ctx.currentTime, end = t + ms / 1000;
      const g = output(0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(volume, end);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(90, t);
      o.frequency.exponentialRampToValueAtTime(260, end);
      const lfo = ctx.createOscillator();            // a pulse that speeds up, like a heartbeat
      const depth = ctx.createGain();
      lfo.frequency.setValueAtTime(3, t);
      lfo.frequency.exponentialRampToValueAtTime(14, end);
      depth.gain.value = 0.5;
      const amp = ctx.createGain();
      amp.gain.value = 0.5;
      lfo.connect(depth).connect(amp.gain);
      o.connect(amp).connect(g);
      o.start(t); lfo.start(t);
      o.stop(end + 0.3); lfo.stop(end + 0.3);
      return { g, nodes: [o, lfo] };
    }
    function synthReveal(volume) {
      const t = ctx.currentTime;
      const g = output(volume);
      g.gain.setValueAtTime(volume, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(330, t);
      o.frequency.exponentialRampToValueAtTime(165, t + 0.25);
      o.connect(g);
      o.start(t); o.stop(t + 0.65);
      return { g, nodes: [o] };
    }
    async function playFile(name, volume) {
      const buf = await load(name);
      if (!buf) return null;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = output(volume);
      src.connect(g);
      src.start();
      return { g, nodes: [src] };
    }
    function stop(h) {
      if (!h || !ctx) return;
      try {
        h.g.gain.cancelScheduledValues(ctx.currentTime);
        h.g.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
        for (const n of h.nodes) n.stop(ctx.currentTime + 0.2);
      } catch { /* already stopped */ }
    }
    async function buildUp(ms, volume = 0.18) {
      unlock();
      if (!ctx) return null;
      return (await playFile('buildup', volume)) || synthBuildUp(ms, volume);
    }
    async function reveal(volume = 0.3) {
      unlock();
      if (!ctx) return null;
      return (await playFile('reveal', volume)) || synthReveal(volume);
    }
    function preload() { list().then(() => { if (!ctx) return; ['buildup', 'reveal'].forEach(load); }); }
    return { unlock, buildUp, reveal, stop, preload };
  })();

  const canVibrate = () => typeof navigator.vibrate === 'function' && !isIOS;
  const haptics = {
    buildUp(ms) { try { if (canVibrate()) navigator.vibrate(buildUpPattern(ms)); } catch { /* bonus only */ } },
    reveal(role) { try { if (canVibrate() && PATTERNS[role]) navigator.vibrate(PATTERNS[role]); } catch { /* bonus only */ } },
    stop() { try { if (canVibrate()) navigator.vibrate(0); } catch { /* bonus only */ } },
    touchStart() { if (isIOS) iosTick(); },
  };

  // ---- Letters to the editor (feedback), shared by host and player pages ----
  const AGAIN = [['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']];
  const QUESTIONS = [
    ['slowed', 'What slowed the game down?', 'e.g. waiting for the host, arguing about rules'],
    ['inTheWay', 'Was there a moment the app got in the way?', 'Be blunt. That’s the useful part.'],
    ['wish', 'Anything you wish it did?', 'Optional'],
  ];

  function letterForm(sent) {
    if (sent) {
      return `<section class="stack" id="fbSent">
        <p class="stamp">Letter received</p>
        <p class="deck">Thanks. The editor reads every one.</p>
        <button class="ghost" type="button" data-fb-edit>Change my answers</button>
      </section>`;
    }
    return `<form class="stack-lg" id="fbForm" autocomplete="off">
      <div class="stack">
        <h2 class="display-l">Letters to the editor</h2>
        <p class="deck">Thirty seconds, while it’s fresh. Answer what you like and skip the rest.</p>
      </div>
      <div class="field">
        <span class="label" id="againLabel">Would you play with this again?</span>
        <div class="chips" role="group" aria-labelledby="againLabel">
          ${AGAIN.map(([v, l]) => `<button type="button" class="chip" data-again="${v}" aria-pressed="false">${l}</button>`).join('')}
        </div>
      </div>
      ${QUESTIONS.map(([k, q, ph]) => `<div class="field"><label for="fb-${k}">${q}</label><textarea id="fb-${k}" name="${k}" maxlength="600" placeholder="${esc(ph)}"></textarea></div>`).join('')}
      <div class="error" id="fbError" role="alert"></div>
      <button class="block secondary" type="submit">Send my letter</button>
    </form>`;
  }

  /** Wires the form inside root. send(body) must POST and throw on failure. */
  function wireLetterForm(root, send, onSent) {
    let again = '';
    root.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-again]');
      if (chip) {
        again = chip.getAttribute('aria-pressed') === 'true' ? '' : chip.dataset.again;
        root.querySelectorAll('[data-again]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.again === again)));
      }
    });
    root.addEventListener('submit', async (e) => {
      if (e.target.id !== 'fbForm') return;
      e.preventDefault();
      const f = e.target;
      const body = { again, slowed: f.slowed.value, inTheWay: f.inTheWay.value, wish: f.wish.value };
      const err = root.querySelector('#fbError');
      err.textContent = '';
      try {
        await send(body);
        again = '';
        onSent();
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  }

  function letterText(l) {
    const again = l.again ? { yes: 'Yes', maybe: 'Maybe', no: 'No' }[l.again] : '';
    return [
      `${l.name} (${l.from}), round ${l.round}`,
      again && `Play again? ${again}`,
      l.slowed && `Slowed it down: ${l.slowed}`,
      l.inTheWay && `App got in the way: ${l.inTheWay}`,
      l.wish && `Wish: ${l.wish}`,
    ].filter(Boolean).join('\n');
  }

  return { esc, ROLES, masthead, wireSteppers, artFiles, illustration, haptics, sound, buildUpPattern, PATTERNS, letterForm, wireLetterForm, letterText };
})();
