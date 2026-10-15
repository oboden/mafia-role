// End-to-end check: one host browser and several phone browsers play whole games.
// Run with the server already up: BASE=http://localhost:3000 node test/e2e.js
// Needs Playwright (npm i -D playwright). SHOTS=dir saves a screenshot of every screen.
const { chromium, devices } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const phoneCtx = (browser) => browser.newContext({ ...devices['iPhone 13'] });

async function peekRole(page) {
  await page.locator('#card').dispatchEvent('pointerdown', { pointerId: 1 });
  await page.waitForSelector('#cardShown:not([hidden])');
  const role = (await page.textContent('#roleName')).trim().toLowerCase();
  return role;
}
async function letGo(page) {
  await page.locator('#card').dispatchEvent('pointerup', { pointerId: 1 });
  await page.waitForSelector('#cardHidden:not([hidden])');
}

async function createGame(browser, { players, mafia, doctors }) {
  const ctx = await phoneCtx(browser);
  const gm = await ctx.newPage();
  await gm.goto(`${BASE}/new`);
  await shot(gm, '00-gm-setup');
  await gm.fill('#players', String(players));
  await gm.fill('#mafia', String(mafia));
  await gm.fill('#doctors', String(doctors));
  await gm.click('button[type=submit]');
  await gm.waitForURL(/\/gm\/[A-Z]{4}#/);
  const code = gm.url().match(/\/gm\/([A-Z]{4})/)[1];
  await gm.waitForFunction(() => document.querySelector('#qr')?.naturalWidth > 0);
  return { gm, code };
}

async function joinPhones(browser, code, names) {
  const phones = [];
  for (const name of names) {
    const ctx = await phoneCtx(browser);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/j/${code}`);
    await page.fill('#name', name);
    await page.click('#joinBtn');
    await page.waitForSelector('#role:not([hidden])');
    assert.ok(await page.isHidden('#cardShown'), 'role starts hidden');
    const role = await peekRole(page);
    await letGo(page);
    phones.push({ name, ctx, page, role });
  }
  return phones;
}

// Tap a player in a pick list by name.
const pick = (gm, name) => gm.locator('.pick', { hasText: name }).first().click();
const tap = (gm, text) => gm.getByRole('button', { name: text, exact: true }).click();

(async () => {
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});

  // ===== Part 0: the front page =====
  {
    const page = await (await phoneCtx(browser)).newPage();
    await page.goto(BASE);
    await page.waitForSelector('svg.scene');
    await page.waitForTimeout(600);
    await shot(page, '00a-cover');
    // Joining with a bad code explains itself.
    await page.fill('#code', 'ZZZZ');
    await page.click('#join button');
    await page.waitForFunction(() => document.querySelector('#joinError').textContent.includes('No game'));
    await page.click('#startBtn');
    await page.waitForURL(/\/new$/);
    await page.waitForSelector('#setup');
    console.log('part 0 (front page) ok');
  }

  // ===== Part 1: dealing, joining, removing, new rounds (the original features) =====
  {
    const { gm, code } = await createGame(browser, { players: 6, mafia: 2, doctors: 1 });
    await shot(gm, '01-gm-lobby-empty');
    const bad = await fetch(`${BASE}/api/rooms`, { method: 'POST', body: JSON.stringify({ players: 4, mafia: 2, doctors: 1 }) });
    assert.strictEqual(bad.status, 400, 'invalid setup refused');

    const phones = await joinPhones(browser, code, ['Ada', 'Ben', 'Cleo', 'Dami', 'Efe', 'Fola']);
    const counts = phones.reduce((m, p) => ((m[p.role] = (m[p.role] || 0) + 1), m), {});
    assert.deepStrictEqual(counts, { mafia: 2, doctor: 1, villager: 3 });
    await shot(phones[0].page, '02-phone-role-hidden');

    await gm.waitForFunction(() => document.querySelectorAll('#seats li').length === 6);
    assert.match(await gm.textContent('#countLabel'), /All 6/);
    assert.strictEqual(await gm.locator('#seats .role.hidden').count(), 6);
    await gm.click('#toggleRoles');
    for (const p of phones) {
      const row = gm.locator('#seats li', { hasText: p.name });
      assert.strictEqual((await row.locator('.role').textContent()).toLowerCase(), p.role, `GM role for ${p.name}`);
    }
    await shot(gm, '03-gm-lobby-full');

    // Mafia see each other; villagers don't.
    const mafia = phones.filter((p) => p.role === 'mafia');
    for (const m of mafia) {
      const other = mafia.find((x) => x !== m).name;
      await m.page.waitForFunction((n) => document.querySelector('#partners').textContent.includes(n), other);
    }
    assert.ok(await phones.find((p) => p.role === 'villager').page.isHidden('#partners'));
    await peekRole(mafia[0].page);
    await shot(mafia[0].page, '04-phone-role-revealed');
    await letGo(mafia[0].page);

    // A seventh phone is refused.
    const extraCtx = await browser.newContext({ ...devices['Pixel 7'] });
    const extra = await extraCtx.newPage();
    await extra.goto(`${BASE}/j/${code}`);
    await extra.waitForSelector('#full:not([hidden])');

    // Refresh and re-scan keep the role.
    const ada = phones[0];
    await ada.page.reload();
    await ada.page.waitForSelector('#role:not([hidden])');
    assert.strictEqual(await peekRole(ada.page), ada.role);
    await letGo(ada.page);
    await gm.reload();
    await gm.waitForFunction(() => document.querySelectorAll('#seats li').length === 6);

    // Remove Fola; their phone sees it, and the freed role goes to the extra phone.
    const fola = phones[5];
    gm.once('dialog', (d) => d.accept());
    await gm.locator('#seats li', { hasText: 'Fola' }).locator('button').click();
    await fola.page.waitForSelector('#joinForm:not([hidden])');
    assert.match(await fola.page.textContent('#joinTitle'), /taken off/);
    await extra.reload();
    await extra.fill('#name', 'Ada');
    await extra.click('#joinBtn');
    await extra.waitForFunction(() => document.querySelector('#error').textContent.includes('already joined'));
    await extra.fill('#name', 'Gbenga');
    await extra.click('#joinBtn');
    await extra.waitForSelector('#role:not([hidden])');
    assert.strictEqual(await peekRole(extra), fola.role, 'freed role reassigned');

    // New round: phones are prompted, the list clears, counts can change.
    await gm.click('details.settings summary');
    await gm.fill('#players', '5');
    await gm.fill('#mafia', '1');
    gm.once('dialog', (d) => d.accept());
    await gm.click('#redeal');
    await gm.waitForFunction(() => document.querySelectorAll('#seats li').length === 0);
    for (const p of phones.slice(0, 5)) {
      await p.page.waitForFunction(() => document.querySelector('#joinTitle').textContent.includes('Fresh roles'));
      assert.strictEqual(await p.page.inputValue('#name'), p.name, 'name remembered');
    }
    await shot(phones[0].page, '05-phone-new-round');

    // Unknown room and wrong host token.
    const lost = await browser.newPage();
    await lost.goto(`${BASE}/j/ZZZZ`);
    await lost.waitForSelector('#gone:not([hidden])');
    const spy = await browser.newPage();
    await spy.goto(`${BASE}/gm/${code}#not-the-token`);
    await spy.waitForSelector('#denied');
    console.log('part 1 (dealing) ok');
  }

  // ===== Part 2: a whole game with night, morning, trials and votes =====
  {
    const { gm, code } = await createGame(browser, { players: 5, mafia: 1, doctors: 1 });
    await shot(gm, '10-gm-setup-done');
    const phones = await joinPhones(browser, code, ['Ada', 'Ben', 'Cleo', 'Dami', 'Efe']);
    const mafia = phones.find((p) => p.role === 'mafia');
    const doctor = phones.find((p) => p.role === 'doctor');
    const [v1, v2, v3] = phones.filter((p) => p.role === 'villager');

    // Late phone can't join once the game starts.
    await gm.waitForFunction(() => document.querySelectorAll('#seats li').length === 5);
    await tap(gm, 'Start the game');

    // Night 1: Mafia attack v1, Doctor saves v2 -> v1 dies.
    await gm.waitForSelector('body.night');
    await shot(gm, '11-gm-night-falls');
    await tap(gm, 'Wake the Mafia');
    assert.ok(await gm.getByRole('button', { name: 'Mafia, close your eyes' }).isDisabled(), 'must pick first');
    await pick(gm, v1.name);
    await shot(gm, '12-gm-night-mafia');
    await tap(gm, 'Mafia, close your eyes');
    await pick(gm, v2.name);
    await shot(gm, '13-gm-night-doctor');
    await tap(gm, 'Doctor, close your eyes');
    await shot(gm, '14-gm-night-dawn');
    await tap(gm, 'Print the morning paper');
    await gm.waitForSelector('.front-page');
    assert.ok(!(await gm.evaluate(() => document.body.classList.contains('night'))), 'morning is day theme');
    assert.ok((await gm.textContent('.front-page')).includes(v1.name), 'paper names the victim');
    await shot(gm, '15-gm-morning-killed');

    // v1's phone shows they're out.
    await v1.page.waitForFunction(() => document.querySelector('#statusTitle').textContent.includes('out'));
    await shot(v1.page, '16-phone-killed');

    // Day 1: v2 on trial, spared; then v2 on trial, voted out.
    await tap(gm, 'Start the day');
    await gm.waitForSelector('#timerOut');
    await shot(gm, '17-gm-day');
    await gm.locator('[data-trial]', { hasText: v2.name }).click();
    await gm.waitForSelector('#trial');
    await shot(gm, '18-gm-trial');
    await tap(gm, 'Spared');
    await gm.waitForSelector('.notice');
    assert.match(await gm.textContent('.notice'), /spared/);
    await gm.locator('[data-trial]', { hasText: v2.name }).click();
    await tap(gm, 'Voted out');
    await gm.waitForSelector('.front-page');
    assert.match(await gm.textContent('.front-page'), new RegExp(`${v2.name} voted out`));
    await shot(gm, '19-gm-obituary');

    // Undo the vote, then redo it.
    await tap(gm, 'Undo last step');
    await gm.waitForSelector('#timerOut');
    await gm.locator('[data-trial]', { hasText: v2.name }).click();
    await tap(gm, 'Voted out');
    await gm.waitForSelector('.front-page');
    await tap(gm, 'Night falls');

    // Night 2: Mafia attack v3, Doctor saves v3 -> nobody dies.
    await gm.waitForSelector('body.night');
    await tap(gm, 'Wake the Mafia');
    await pick(gm, v3.name);
    await tap(gm, 'Mafia, close your eyes');
    await pick(gm, v3.name);
    await tap(gm, 'Doctor, close your eyes');
    await tap(gm, 'Print the morning paper');
    await gm.waitForSelector('.front-page');
    assert.match(await gm.textContent('.front-page'), /Nobody died/);
    await shot(gm, '20-gm-morning-saved');

    // Day 2: vote out the Mafia -> town wins.
    await tap(gm, 'Start the day');
    await gm.locator('[data-trial]', { hasText: mafia.name }).click();
    await tap(gm, 'Voted out');
    await gm.waitForSelector('#roster');
    assert.match(await gm.textContent('.front-page'), /town is safe/);
    await shot(gm, '21-gm-final-edition');

    // Every phone gets the final edition and the full roster.
    for (const p of phones) {
      await p.page.waitForSelector('#over:not([hidden])');
      assert.strictEqual(await p.page.locator('#roster li').count(), 5);
    }
    await shot(doctor.page, '22-phone-final-edition');

    // Letters to the editor: a player writes one, the host sees it.
    const d = doctor.page;
    await d.click('[data-again="yes"]');
    await d.fill('#fb-slowed', 'Waiting for the host to tap through the night');
    await d.fill('#fb-wish', 'A sound when night falls');
    await d.click('#fbForm button[type=submit]');
    await d.waitForSelector('#fbSent');
    await shot(d, '23-phone-letter-sent');
    await gm.waitForFunction(() => document.querySelectorAll('#letters .letter').length === 1);
    assert.match(await gm.textContent('#letters'), /Waiting for the host/);
    // The host writes one too, without losing the letters list.
    await gm.click('[data-again="maybe"]');
    await gm.fill('#fb-inTheWay', 'Nothing really');
    await gm.click('#fbForm button[type=submit]');
    await gm.waitForFunction(() => document.querySelectorAll('#letters .letter').length === 2);
    await shot(gm, '24-gm-letters');

    // Play again goes back to the lobby; phones are invited back.
    gm.once('dialog', (dl) => dl.accept());
    await tap(gm, 'Play again');
    await gm.waitForSelector('#qr');
    await phones[0].page.waitForSelector('#joinForm:not([hidden])');
    console.log('part 2 (full game, town wins) ok');
  }

  // ===== Part 3: Mafia win, and the "game in progress" screen =====
  {
    // Starting short-handed is refused if the Mafia card is still in the deck.
    {
      const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', body: JSON.stringify({ players: 4, mafia: 1, doctors: 0 }) }).then((x) => x.json());
      const deck = ['a', 'b', 'c'];
      for (const [i, n] of deck.entries()) await fetch(`${BASE}/api/rooms/${r.code}/join`, { method: 'POST', body: JSON.stringify({ token: `tok-${r.code}-${i}-xxxxxxxx`, name: n }) });
      const s = await fetch(`${BASE}/api/rooms/${r.code}/start`, { method: 'POST', headers: { 'X-GM-Token': r.gmToken } });
      assert.ok([200, 409].includes(s.status), 'start either works or explains why');
    }

    const { gm, code } = await createGame(browser, { players: 4, mafia: 1, doctors: 0 });
    const phones = await joinPhones(browser, code, ['Ada', 'Ben', 'Cleo', 'Dami']);
    const [t1, t2] = phones.filter((p) => p.role !== 'mafia');
    await gm.waitForFunction(() => document.querySelectorAll('#seats li').length === 4);
    await tap(gm, 'Start the game');
    await gm.waitForSelector('body.night');
    const late = await (await phoneCtx(browser)).newPage();
    await late.goto(`${BASE}/j/${code}`);
    await late.waitForSelector('#started:not([hidden])');
    await shot(late, '30-phone-missed-game');
    await tap(gm, 'Wake the Mafia');
    await pick(gm, t1.name);
    await tap(gm, 'Mafia, close your eyes'); // no doctor step in this game
    await tap(gm, 'Print the morning paper');
    await tap(gm, 'Start the day');
    await gm.locator('[data-trial]', { hasText: t2.name }).click();
    await tap(gm, 'Voted out');
    await gm.waitForSelector('#roster');
    assert.match(await gm.textContent('.front-page'), /Mafia take the town/);
    await shot(gm, '31-gm-mafia-win');
    console.log('part 3 (mafia win) ok');
  }

  // ===== Part 4: haptics on reveal =====
  {
    // Read whatever patterns are defined in public/common.js.
    const probe = await (await phoneCtx(browser)).newPage();
    await probe.goto(BASE);
    const EXPECTED = await probe.evaluate(() => Mafia.PATTERNS);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const buzz = (a) => a.filter((_, i) => i % 2 === 0).reduce((x, y) => x + y, 0);
    const totals = new Set(Object.values(EXPECTED).map(sum));
    const buzzing = new Set(Object.values(EXPECTED).map(buzz));
    if (totals.size > 1 || buzzing.size > 1) {
      console.warn('WARNING: role haptics differ in length or amount of buzzing. Players nearby may be able to hear who is Mafia.');
    }
    // Spy on vibrations (Android) and switch toggles (iPhone).
    const spy = () => {
      window.__buzz = [];
      window.__ticks = 0;
      navigator.vibrate = (p) => { window.__buzz.push(p); return true; };
      document.addEventListener('click', (e) => { if (e.target.matches?.('input[switch]')) window.__ticks += 1; }, true);
    };
    async function playGame(haptics) {
      const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', body: JSON.stringify({ players: 4, mafia: 1, doctors: 1, haptics }) }).then((x) => x.json());
      const results = [];
      for (const [i, deviceName] of ['Pixel 7', 'Pixel 7', 'Pixel 7', 'iPhone 13'].entries()) {
        const ctx = await browser.newContext({ ...devices[deviceName] });
        await ctx.addInitScript(spy);
        const page = await ctx.newPage();
        await page.goto(`${BASE}/j/${r.code}`);
        await page.fill('#name', `P${i}`);
        await page.click('#joinBtn');
        await page.waitForSelector('#role:not([hidden])');
        const role = await peekRole(page);
        await page.waitForTimeout(450);
        const buzzes = await page.evaluate(() => window.__buzz);
        const ticks = await page.evaluate(() => window.__ticks);
        await letGo(page);
        results.push({ deviceName, role, buzzes, ticks });
      }
      return results;
    }
    for (const r of await playGame(true)) {
      if (r.deviceName === 'iPhone 13') {
        assert.ok(r.ticks >= 1, 'iPhone gets at least one tick');
        assert.strictEqual(r.buzzes.length, 0, 'iPhone never calls vibrate');
      } else {
        assert.deepStrictEqual(r.buzzes, [EXPECTED[r.role]], `${r.role} pattern`);
      }
    }
    for (const r of await playGame(false)) {
      assert.strictEqual(r.buzzes.length + r.ticks, 0, 'no haptics when the host turns them off');
    }
    console.log('part 4 (haptics) ok');
  }

  await browser.close();
  console.log('ALL CHECKS PASSED');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
