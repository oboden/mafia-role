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

  // Swap the emoji for artwork if public/illustrations/<role>.png exists.
  const art = {};
  function illustration(el, role) {
    el.textContent = ROLES[role] ? ROLES[role].icon : '';
    el.classList.remove('has-art');
    el.style.backgroundImage = '';
    if (art[role] === false) return;
    const src = `/illustrations/${role}.png`;
    const apply = () => { el.style.backgroundImage = `url(${src})`; el.classList.add('has-art'); };
    if (art[role]) return apply();
    const img = new Image();
    img.onload = () => { art[role] = true; apply(); };
    img.onerror = () => { art[role] = false; };
    img.src = src;
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

  return { esc, ROLES, masthead, wireSteppers, illustration, letterForm, wireLetterForm, letterText };
})();
