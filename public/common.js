// Shared bits for every page.
window.Mafia = (() => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ROLES = {
    mafia: { icon: '🔪', name: 'Mafia', desc: 'Each night, agree with the other Mafia on someone to eliminate. By day, blend in.' },
    doctor: { icon: '💉', name: 'Doctor', desc: 'Each night, point at one person to save. If the Mafia chose them, they live.' },
    villager: { icon: '🏡', name: 'Villager', desc: 'Find the Mafia. Argue, accuse and vote them out before they outnumber you.' },
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

  // Swap the emoji for public/illustrations/<role>.png (or .webp/.gif/.svg/.jpg) if it exists.
  async function illustration(el, role) {
    el.textContent = ROLES[role] ? ROLES[role].icon : '';
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
  // iPhones can't vibrate from a web page. Recent iOS Safari plays a light system
  // tick when a switch control is toggled, which is the closest thing available.
  const TICKS = { mafia: [0, 190], doctor: [0, 110, 220, 330], villager: [0] };
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function iosTick() {
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
  }
  function haptic(role) {
    if (!PATTERNS[role]) return;
    try {
      if (typeof navigator.vibrate === 'function' && !isIOS) { navigator.vibrate(PATTERNS[role]); return; }
      if (isIOS) for (const t of TICKS[role]) (t === 0 ? iosTick() : setTimeout(iosTick, t));
    } catch { /* haptics are a bonus, never an error */ }
  }

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

  return { esc, ROLES, masthead, wireSteppers, artFiles, illustration, haptic, PATTERNS, letterForm, wireLetterForm, letterText };
})();
