// Plays whole games against the API, no browser needed: node test/api.js
const assert = require('assert');
const { server } = require('../server');

const token = (i) => `player-token-${String(i).padStart(8, '0')}`;

(async () => {
  await new Promise((r) => server.listen(0, r));
  const BASE = `http://localhost:${server.address().port}`;

  async function call(method, path, body, gmToken) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(gmToken ? { 'X-GM-Token': gmToken } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  }

  async function newGame(players, mafia, doctors) {
    const { data } = await call('POST', '/api/rooms', { players, mafia, doctors });
    const { code, gmToken } = data;
    const gm = (action, body) => call('POST', `/api/rooms/${code}/${action}`, body || {}, gmToken);
    const names = ['Ada', 'Ben', 'Cleo', 'Dami', 'Efe', 'Fola', 'Gbenga', 'Hana'].slice(0, players);
    for (const [i, name] of names.entries()) {
      const r = await call('POST', `/api/rooms/${code}/join`, { token: token(i), name });
      assert.strictEqual(r.status, 200, `join ${name}`);
    }
    const state = (await call('GET', `/api/rooms/${code}/gm`, null, gmToken)).data;
    const byRole = (role) => state.seats.filter((s) => s.role === role);
    return { code, gmToken, gm, state, byRole };
  }

  // ---- Game 1: town wins ----
  {
    const g = await newGame(6, 1, 1);
    const [mafia] = g.byRole('mafia');
    const [doctor] = g.byRole('doctor');
    const villagers = g.byRole('villager');

    // Can't run night before starting; can't kick or join after starting.
    assert.strictEqual((await g.gm('night', { attackId: villagers[0].id })).status, 409);
    let r = await g.gm('start');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.phase, 'night');
    assert.strictEqual(r.data.night, 1);
    assert.strictEqual((await g.gm('kick', { seatId: villagers[0].id })).status, 409);
    const late = await call('POST', `/api/rooms/${g.code}/join`, { token: token(99), name: 'Late' });
    assert.strictEqual(late.status, 409);
    assert.match(late.data.error, /already started/);

    // Night 1: Mafia attack villager 0, Doctor saves them -> nobody dies.
    r = await g.gm('night', { attackId: villagers[0].id, saveId: villagers[0].id });
    assert.strictEqual(r.data.phase, 'morning');
    assert.strictEqual(r.data.report.killedId, null);
    assert.strictEqual(r.data.seats.filter((s) => !s.alive).length, 0);

    // Day 1: villager 1 is spared, then villager 1 voted out.
    assert.strictEqual((await g.gm('vote', { seatId: villagers[1].id, outcome: 'out' })).status, 409, 'no vote in morning');
    r = await g.gm('day');
    assert.strictEqual(r.data.phase, 'day');
    r = await g.gm('vote', { seatId: villagers[1].id, outcome: 'spared' });
    assert.strictEqual(r.data.phase, 'day');
    r = await g.gm('vote', { seatId: villagers[1].id, outcome: 'out' });
    assert.strictEqual(r.data.phase, 'dusk');
    assert.strictEqual(r.data.seats.find((s) => s.id === villagers[1].id).alive, false);

    // Undo the vote, then redo it.
    r = await g.gm('undo');
    assert.strictEqual(r.data.phase, 'day');
    assert.strictEqual(r.data.seats.find((s) => s.id === villagers[1].id).alive, true, 'undo revives');
    r = await g.gm('vote', { seatId: villagers[1].id, outcome: 'out' });
    assert.strictEqual(r.data.phase, 'dusk');

    // The voted-out player's phone knows.
    const me = await call('GET', `/api/rooms/${g.code}/me?token=${token(g.state.seats.findIndex((s) => s.id === villagers[1].id))}`);
    assert.strictEqual(me.data.seat.alive, false);
    assert.strictEqual(me.data.seat.out.how, 'vote');

    // Night 2: Mafia kill the doctor; can't target someone already out.
    r = await g.gm('sleep');
    assert.strictEqual(r.data.phase, 'night');
    assert.strictEqual(r.data.night, 2);
    assert.strictEqual((await g.gm('night', { attackId: villagers[1].id })).status, 409);
    r = await g.gm('night', { attackId: doctor.id, saveId: null });
    assert.strictEqual(r.data.report.killedId, doctor.id);

    // Night 3: doctor is dead, so a save is ignored.
    await g.gm('day');
    await g.gm('sleep');
    r = await g.gm('night', { attackId: villagers[2].id, saveId: villagers[2].id });
    assert.strictEqual(r.data.report.killedId, villagers[2].id, 'dead doctor cannot save');
    // Alive now: mafia + villager 0 + villager 3 -> vote out mafia, town wins.
    await g.gm('day');
    r = await g.gm('vote', { seatId: mafia.id, outcome: 'out' });
    assert.strictEqual(r.data.phase, 'over');
    assert.strictEqual(r.data.winner, 'town');

    // Everyone's phone gets the full roster at the end.
    const end = await call('GET', `/api/rooms/${g.code}/me?token=${token(0)}`);
    assert.strictEqual(end.data.roster.length, 6);

    // Feedback from a player and from the host; resending replaces.
    assert.strictEqual((await call('POST', `/api/rooms/${g.code}/feedback`, { token: token(0) })).status, 400, 'empty letter refused');
    await call('POST', `/api/rooms/${g.code}/feedback`, { token: token(0), again: 'yes', wish: 'a timer' });
    await call('POST', `/api/rooms/${g.code}/feedback`, { token: token(0), again: 'maybe', slowed: 'votes' });
    await call('POST', `/api/rooms/${g.code}/feedback`, { again: 'yes' }, g.gmToken);
    const gmState = (await call('GET', `/api/rooms/${g.code}/gm`, null, g.gmToken)).data;
    assert.strictEqual(gmState.feedback.length, 2);
    assert.ok(gmState.feedback.every((f) => !('token' in f)), 'tokens never leave the server');
    assert.strictEqual(gmState.feedback.find((f) => f.from === 'player').again, 'maybe');
    const meAfter = await call('GET', `/api/rooms/${g.code}/me?token=${token(0)}`);
    assert.strictEqual(meAfter.data.feedbackSent, true);

    // Play again resets to the lobby but keeps the letters.
    r = await g.gm('deal', { players: 6, mafia: 1, doctors: 1 });
    assert.strictEqual(r.data.phase, 'lobby');
    assert.strictEqual(r.data.feedback.length, 2);
    console.log('game 1 (town wins) ok');
  }

  // ---- Game 2: mafia win by matching the town ----
  {
    const g = await newGame(5, 1, 1);
    const [mafia] = g.byRole('mafia');
    const others = g.state.seats.filter((s) => s.role !== 'mafia');
    await g.gm('start');
    await g.gm('night', { attackId: others[0].id }); // 3 town + 1 mafia left
    await g.gm('day');
    let r = await g.gm('vote', { seatId: others[1].id, outcome: 'out' }); // 2 town + 1 mafia
    assert.strictEqual(r.data.phase, 'dusk');
    await g.gm('sleep');
    r = await g.gm('night', { attackId: others[2].id }); // 1 town + 1 mafia -> mafia win
    assert.strictEqual(r.data.phase, 'over');
    assert.strictEqual(r.data.winner, 'mafia');
    // Undo out of a finished game works too.
    r = await g.gm('undo');
    assert.strictEqual(r.data.phase, 'night');
    assert.strictEqual(r.data.winner, null);
    assert.ok(mafia);
    console.log('game 2 (mafia wins, undo from game over) ok');
  }

  // ---- Haptics setting reaches phones ----
  {
    const on = (await call('POST', '/api/rooms', { players: 4, mafia: 1, doctors: 1 })).data;
    const off = (await call('POST', '/api/rooms', { players: 4, mafia: 1, doctors: 1, haptics: false })).data;
    assert.strictEqual((await call('GET', `/api/rooms/${on.code}/me?token=${token(1)}`)).data.haptics, true, 'on by default');
    assert.strictEqual((await call('GET', `/api/rooms/${off.code}/me?token=${token(1)}`)).data.haptics, false);
    const art = await call('GET', '/api/art');
    assert.ok(Array.isArray(art.data.files));
    console.log('haptics setting ok');
  }

  // ---- Starting rules ----
  {
    const { data } = await call('POST', '/api/rooms', { players: 8, mafia: 2, doctors: 1 });
    const gm = (action, body) => call('POST', `/api/rooms/${data.code}/${action}`, body || {}, data.gmToken);
    assert.strictEqual((await gm('start')).status, 409, 'needs 3 players');
    const wrong = await call('POST', `/api/rooms/${data.code}/start`, {}, 'nope');
    assert.strictEqual(wrong.status, 403);
    console.log('start rules ok');
  }

  server.close();
  console.log('ALL API CHECKS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
