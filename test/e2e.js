// End-to-end check: one game master browser and several phone browsers.
// Run with the server already up: BASE=http://localhost:3000 node test/e2e.js
const { chromium, devices } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || null;

(async () => {
  const browser = await chromium.launch();
  const gmCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const gm = await gmCtx.newPage();

  // Game master sets up 6 players: 2 mafia, 1 doctor, 3 villagers.
  await gm.goto(BASE);
  await gm.fill('#players', '6');
  assert.strictEqual(await gm.inputValue('#mafia'), '1', 'auto mafia default for 6 players');
  await gm.fill('#mafia', '2');
  await gm.fill('#doctors', '1');
  assert.strictEqual(await gm.inputValue('#villagers'), '3');
  await gm.click('button[type=submit]');
  await gm.waitForURL(/\/gm\/[A-Z]{4}#/);
  const code = gm.url().match(/\/gm\/([A-Z]{4})/)[1];
  await gm.waitForSelector('#qr');
  await gm.waitForFunction(() => document.querySelector('#qr').naturalWidth > 0);
  const qrSrc = await gm.getAttribute('#qr', 'src');
  console.log('room', code, 'qr', qrSrc);

  // Invalid setup is refused.
  const bad = await fetch(`${BASE}/api/rooms`, { method: 'POST', body: JSON.stringify({ players: 4, mafia: 2, doctors: 1 }) });
  assert.strictEqual(bad.status, 400);

  // Six phones join.
  const names = ['Ada', 'Ben', 'Cleo', 'Dami', 'Efe', 'Fola'];
  const phones = [];
  for (const name of names) {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/j/${code}`);
    await page.fill('#name', name);
    await page.click('#joinBtn');
    await page.waitForSelector('#role:not([hidden])');
    // Role stays hidden until tapped.
    assert.ok(await page.isHidden('#cardShown'));
    await page.click('#card');
    const role = (await page.textContent('#roleName')).trim().toLowerCase();
    phones.push({ name, ctx, page, role });
  }
  const counts = phones.reduce((m, p) => ((m[p.role] = (m[p.role] || 0) + 1), m), {});
  console.log('dealt', phones.map((p) => `${p.name}=${p.role}`).join(' '));
  assert.deepStrictEqual(counts, { mafia: 2, doctor: 1, villager: 3 });

  // GM sees everyone live, roles hidden until toggled, and they match the phones.
  await gm.waitForFunction(() => document.querySelectorAll('#seats tr').length === 6);
  assert.match(await gm.textContent('#countLabel'), /All 6 players/);
  assert.strictEqual(await gm.locator('.role-tag.hidden').count(), 6);
  await gm.click('#toggleRoles');
  for (const p of phones) {
    const row = gm.locator('#seats tr', { hasText: p.name });
    assert.strictEqual((await row.locator('.role-tag').textContent()).toLowerCase(), p.role, `GM role for ${p.name}`);
  }
  if (SHOTS) await gm.screenshot({ path: `${SHOTS}/gm.png`, fullPage: true });

  // Mafia see each other.
  const mafia = phones.filter((p) => p.role === 'mafia');
  for (const m of mafia) {
    const other = mafia.find((x) => x !== m).name;
    await m.page.waitForFunction((n) => document.querySelector('#partners').textContent.includes(n), other);
  }
  const villager = phones.find((p) => p.role === 'villager');
  assert.ok(await villager.page.isHidden('#partners'));
  if (SHOTS) {
    await mafia[0].page.screenshot({ path: `${SHOTS}/phone-mafia.png` });
    const doc = phones.find((p) => p.role === 'doctor');
    await doc.page.screenshot({ path: `${SHOTS}/phone-doctor.png` });
  }

  // A seventh phone is refused.
  const extraCtx = await browser.newContext({ ...devices['Pixel 7'] });
  const extra = await extraCtx.newPage();
  await extra.goto(`${BASE}/j/${code}`);
  await extra.waitForSelector('#full:not([hidden])');
  const apiRefuse = await fetch(`${BASE}/api/rooms/${code}/join`, {
    method: 'POST', body: JSON.stringify({ token: 'x'.repeat(32), name: 'Gbenga' }),
  });
  assert.strictEqual(apiRefuse.status, 409);
  console.log('7th player refused:', (await apiRefuse.json()).error);

  // Refreshing a phone keeps its role.
  const ada = phones[0];
  await ada.page.reload();
  await ada.page.waitForSelector('#role:not([hidden])');
  await ada.page.click('#card');
  assert.strictEqual((await ada.page.textContent('#roleName')).trim().toLowerCase(), ada.role);
  // Re-scanning the QR on the same phone also keeps it.
  await ada.page.goto(`${BASE}/j/${code}`);
  await ada.page.waitForSelector('#role:not([hidden])');
  assert.strictEqual(await gm.locator('#seats tr').count(), 6);

  // GM refresh keeps control.
  await gm.reload();
  await gm.waitForFunction(() => document.querySelectorAll('#seats tr').length === 6);

  // GM removes Fola; their phone sees it, and the freed role goes to the extra phone.
  const fola = phones[5];
  gm.once('dialog', (d) => d.accept());
  await gm.locator('#seats tr', { hasText: 'Fola' }).locator('button').click();
  await fola.page.waitForSelector('#joinForm:not([hidden])');
  assert.match(await fola.page.textContent('#joinTitle'), /removed/);
  await extra.reload();
  await extra.fill('#name', 'Ada');
  await extra.click('#joinBtn');
  await extra.waitForFunction(() => document.querySelector('#error').textContent.includes('already joined'));
  await extra.fill('#name', 'Gbenga');
  await extra.click('#joinBtn');
  await extra.waitForSelector('#role:not([hidden])');
  await extra.click('#card');
  assert.strictEqual((await extra.textContent('#roleName')).trim().toLowerCase(), fola.role, 'freed role reassigned');
  await gm.waitForFunction(() => document.body.textContent.includes('Gbenga'));

  // New round: phones are prompted, the GM list clears, counts can change.
  await gm.click('details.settings summary');
  await gm.fill('#players', '5');
  await gm.fill('#mafia', '1');
  gm.once('dialog', (d) => d.accept());
  await gm.click('#redeal');
  await gm.waitForFunction(() => document.querySelectorAll('#seats tr').length === 0);
  for (const p of phones.slice(0, 5)) {
    await p.page.waitForFunction(() => document.querySelector('#joinTitle').textContent.includes('New round'));
    assert.strictEqual(await p.page.inputValue('#name'), p.name, 'name remembered');
    await p.page.click('#joinBtn');
    await p.page.waitForSelector('#role:not([hidden])');
    assert.ok(await p.page.isHidden('#cardShown'), 'new role starts hidden');
  }
  await gm.waitForFunction(() => document.querySelectorAll('#seats tr').length === 5);
  assert.match(await gm.textContent('#summary'), /1 Mafia/);

  // Unknown room and wrong GM token.
  const lost = await browser.newPage();
  await lost.goto(`${BASE}/j/ZZZZ`);
  await lost.waitForSelector('#gone:not([hidden])');
  const spy = await browser.newPage();
  await spy.goto(`${BASE}/gm/${code}#not-the-token`);
  await spy.waitForSelector('#denied:not([hidden])');

  await browser.close();
  console.log('ALL CHECKS PASSED');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
