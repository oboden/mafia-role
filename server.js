// Mafia role dealer: the game master creates a room, players scan a QR code
// and each phone is dealt one secret role. No database; rooms live in memory
// and are snapshotted to data/rooms.json so a restart doesn't lose a game.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'rooms.json');
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // forget rooms idle for 12 hours
const MAX_PLAYERS = 40;

const ROLES = ['mafia', 'doctor', 'villager'];

/** @type {Map<string, any>} */
const rooms = new Map();
// Live connections, kept out of the room objects so rooms stay serialisable.
const gmStreams = new Map(); // code -> Set<res>
const playerStreams = new Map(); // code -> Map<playerToken, Set<res>>

// ---------- persistence ----------

function loadRooms() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const room of saved) rooms.set(room.code, room);
    console.log(`Restored ${rooms.size} room(s) from ${DATA_FILE}`);
  } catch {
    // no snapshot yet
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...rooms.values()]));
    } catch (err) {
      console.error('Could not save rooms:', err.message);
    }
  }, 500);
}

// ---------- game logic ----------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function defaultMafia(players) {
  return Math.max(1, Math.floor(players / 4));
}

/** Validates a setup and returns {players, mafia, doctors, mafiaSeeEachOther} or an error string. */
function parseSetup(body) {
  const players = Number.parseInt(body.players, 10);
  if (!Number.isInteger(players) || players < 3 || players > MAX_PLAYERS) {
    return `Players must be between 3 and ${MAX_PLAYERS}.`;
  }
  const mafia = body.mafia === undefined || body.mafia === '' ? defaultMafia(players) : Number.parseInt(body.mafia, 10);
  const doctors = body.doctors === undefined || body.doctors === '' ? 1 : Number.parseInt(body.doctors, 10);
  if (!Number.isInteger(mafia) || mafia < 1) return 'There must be at least 1 Mafia.';
  if (!Number.isInteger(doctors) || doctors < 0) return 'Doctors cannot be negative.';
  if (mafia >= players - mafia) return 'Mafia must be fewer than everyone else, or they win immediately.';
  if (mafia + doctors >= players) return 'Leave room for at least 1 Villager.';
  return {
    players,
    mafia,
    doctors,
    mafiaSeeEachOther: body.mafiaSeeEachOther !== false,
    revealOnDeath: body.revealOnDeath !== false,
  };
}

function buildDeck({ players, mafia, doctors }) {
  const deck = [];
  for (let i = 0; i < mafia; i++) deck.push('mafia');
  for (let i = 0; i < doctors; i++) deck.push('doctor');
  while (deck.length < players) deck.push('villager');
  return shuffle(deck);
}

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they look like 1 and 0
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// A game moves through these phases. The phones only record what the room
// decided out loud: the host taps who the Mafia pointed at, who the Doctor
// saved, and who the table voted out.
//   lobby   -> players scan and get roles
//   night   -> host walks the Mafia and Doctor through their turns
//   morning -> the "morning paper" says what happened overnight
//   day     -> discussion, trials and votes
//   dusk    -> someone was voted out; their obituary is read
//   over    -> one side has won
function dealRound(room, setup) {
  Object.assign(room, setup);
  room.round = (room.round || 0) + 1;
  room.deck = buildDeck(room);
  room.seats = [];
  room.phase = 'lobby';
  room.night = 0;
  room.report = null;
  room.lastVote = null;
  room.winner = null;
  room.history = [];
  room.feedback = room.feedback || [];
  room.touched = Date.now();
}

/** Rooms saved by an older version of the app lack the game-phase fields. */
function normalise(room) {
  room.phase = room.phase || 'lobby';
  room.night = room.night || 0;
  room.history = room.history || [];
  room.feedback = room.feedback || [];
  if (room.revealOnDeath === undefined) room.revealOnDeath = true;
  return room;
}

function seatOf(room, token) {
  return room.seats.find((s) => s.token === token);
}

const isAlive = (s) => s.alive !== false;
const aliveSeats = (room) => room.seats.filter(isAlive);

/** 'town' when every Mafia is out, 'mafia' once they match everyone else, otherwise null. */
function winnerOf(room) {
  const alive = aliveSeats(room);
  const mafia = alive.filter((s) => s.role === 'mafia').length;
  if (mafia === 0) return 'town';
  if (mafia >= alive.length - mafia) return 'mafia';
  return null;
}

function eliminate(seat, how, night) {
  seat.alive = false;
  seat.out = { how, night };
}

// Undo: the host is running a game in a dark room from memory, so every phase
// change can be stepped back once.
function snapshot(room) {
  room.history.push(JSON.stringify({
    phase: room.phase,
    night: room.night,
    report: room.report,
    lastVote: room.lastVote,
    winner: room.winner,
    seats: room.seats.map((s) => ({ id: s.id, alive: s.alive, out: s.out })),
  }));
  if (room.history.length > 40) room.history.shift();
}

function restore(room) {
  const saved = JSON.parse(room.history.pop());
  Object.assign(room, { phase: saved.phase, night: saved.night, report: saved.report, lastVote: saved.lastVote, winner: saved.winner });
  for (const s of room.seats) {
    const prev = saved.seats.find((p) => p.id === s.id);
    s.alive = prev ? prev.alive : true;
    s.out = prev ? prev.out : undefined;
  }
}

function seatSummary(s) {
  return { id: s.id, name: s.name, role: s.role, joinedAt: s.joinedAt, alive: isAlive(s), out: s.out || null };
}

function gmView(room) {
  return {
    code: room.code,
    round: room.round,
    players: room.players,
    mafia: room.mafia,
    doctors: room.doctors,
    mafiaSeeEachOther: room.mafiaSeeEachOther,
    revealOnDeath: room.revealOnDeath,
    phase: room.phase,
    night: room.night,
    report: room.report,
    lastVote: room.lastVote,
    winner: room.winner,
    canUndo: room.history.length > 0,
    seats: room.seats.map(seatSummary),
    remaining: room.deck.length,
    feedback: room.feedback.map(({ token, ...rest }) => rest),
  };
}

function playerView(room, token) {
  const seat = seatOf(room, token);
  const view = {
    code: room.code,
    round: room.round,
    full: room.deck.length === 0,
    phase: room.phase,
    night: room.night,
    winner: room.winner,
    seat: null,
    feedbackSent: room.feedback.some((f) => f.token === token && f.round === room.round),
  };
  if (seat) {
    view.seat = { name: seat.name, role: seat.role, alive: isAlive(seat), out: seat.out || null };
    if (seat.role === 'mafia' && room.mafiaSeeEachOther) {
      view.seat.partners = room.seats
        .filter((s) => s.role === 'mafia' && s !== seat)
        .map((s) => ({ name: s.name, alive: isAlive(s) }));
    }
  }
  // When the game ends everyone gets to see who was who.
  if (room.phase === 'over') {
    view.roster = room.seats.map((s) => ({ name: s.name, role: s.role, alive: isAlive(s), out: s.out || null }));
  }
  return view;
}

function findAlive(room, id) {
  if (id === null || id === undefined || id === '') return null;
  return room.seats.find((s) => s.id === Number(id) && isAlive(s)) || undefined;
}

/** Applies one game-master phase action. Returns an error string, or nothing on success. */
function runPhaseAction(room, action, body) {
  const phase = room.phase;

  if (action === 'undo') {
    if (!room.history.length) return 'Nothing to undo.';
    restore(room);
    return;
  }

  if (action === 'start') {
    if (phase !== 'lobby') return 'The game has already started.';
    const seated = room.seats.length;
    if (seated < 3) return 'You need at least 3 players in before starting.';
    const mafia = room.seats.filter((s) => s.role === 'mafia').length;
    if (mafia === 0) return 'None of the Mafia have scanned yet. Wait for more players.';
    if (mafia >= seated - mafia) return 'Too many Mafia have joined compared to everyone else. Wait for more players.';
    snapshot(room);
    room.deck = []; // anyone who didn't scan in time sits this round out
    for (const s of room.seats) { s.alive = true; s.out = undefined; }
    room.phase = 'night';
    room.night = 1;
    room.report = null;
    room.lastVote = null;
    return;
  }

  if (action === 'night') {
    if (phase !== 'night') return 'It is not night time.';
    const attacked = findAlive(room, body.attackId);
    if (attacked === undefined) return 'The Mafia must pick someone who is still in the game.';
    const doctorAlive = aliveSeats(room).some((s) => s.role === 'doctor');
    let saved = doctorAlive ? findAlive(room, body.saveId) : null;
    if (saved === undefined) return 'The Doctor must pick someone who is still in the game.';
    snapshot(room);
    const killed = attacked && (!saved || saved.id !== attacked.id) ? attacked : null;
    if (killed) eliminate(killed, 'night', room.night);
    room.report = {
      night: room.night,
      attackedId: attacked ? attacked.id : null,
      savedId: saved ? saved.id : null,
      killedId: killed ? killed.id : null,
    };
    room.winner = winnerOf(room);
    room.phase = room.winner ? 'over' : 'morning';
    return;
  }

  if (action === 'day') {
    if (phase !== 'morning') return 'Read the morning paper first.';
    snapshot(room);
    room.phase = 'day';
    room.lastVote = null;
    return;
  }

  if (action === 'vote') {
    if (phase !== 'day') return 'Votes happen during the day.';
    const seat = findAlive(room, body.seatId);
    if (!seat) return 'Pick someone who is still in the game.';
    if (!['out', 'spared'].includes(body.outcome)) return 'Say whether they were voted out or spared.';
    snapshot(room);
    room.lastVote = { seatId: seat.id, outcome: body.outcome, night: room.night };
    if (body.outcome === 'out') {
      eliminate(seat, 'vote', room.night);
      room.winner = winnerOf(room);
      room.phase = room.winner ? 'over' : 'dusk';
    }
    return;
  }

  if (action === 'sleep') {
    if (phase !== 'day' && phase !== 'dusk') return 'Night only falls after a day.';
    snapshot(room);
    room.phase = 'night';
    room.night += 1;
    room.lastVote = null;
    room.report = null;
    return;
  }

  return 'Unknown action.';
}

// Free hosts (Render's free tier) wipe the disk when the app sleeps, so the
// host should copy letters off the final screen the same night. Setting
// FEEDBACK_WEBHOOK to any URL that accepts JSON (a Google Apps Script, a
// Discord or Slack webhook, Formspree...) also sends each letter there.
function forwardFeedback(room, letter) {
  const url = process.env.FEEDBACK_WEBHOOK;
  if (!url) return;
  const { token, ...rest } = letter;
  const payload = { game: room.code, players: room.seats.length, ...rest, at: new Date(letter.at).toISOString() };
  // Discord and Slack webhooks only show a "content"/"text" field.
  const summary = `Letter from ${rest.name} (${rest.from}) in game ${room.code}: play again? ${rest.again || '-'} | slowed: ${rest.slowed || '-'} | got in the way: ${rest.inTheWay || '-'} | wish: ${rest.wish || '-'}`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, content: summary, text: summary }),
  }).catch((err) => console.error('Feedback webhook failed:', err.message));
}

// ---------- live updates (Server-Sent Events) ----------

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
}

function send(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room) {
  for (const res of gmStreams.get(room.code) || []) send(res, gmView(room));
  const byToken = playerStreams.get(room.code);
  if (byToken) {
    for (const [token, set] of byToken) {
      const view = playerView(room, token);
      for (const res of set) send(res, view);
    }
  }
  scheduleSave();
}

// Proxies (Render, nginx) close idle connections; a comment line keeps them open.
setInterval(() => {
  for (const set of gmStreams.values()) for (const res of set) res.write(': ping\n\n');
  for (const map of playerStreams.values()) for (const set of map.values()) for (const res of set) res.write(': ping\n\n');
}, 25000).unref();

setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.touched < cutoff) rooms.delete(code);
  }
  scheduleSave();
}, 60 * 60 * 1000).unref();

// ---------- HTTP plumbing ----------

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 404, { error: 'Not found' });
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function lanUrls() {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

function isGm(room, req, body) {
  const token = (body && body.gmToken) || req.headers['x-gm-token'];
  return Boolean(token) && token === room.gmToken;
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  // Pages
  if (method === 'GET' && parts.length === 0) return serveFile(res, 'index.html');
  if (method === 'GET' && parts[0] === 'gm' && parts.length === 2) return serveFile(res, 'gm.html');
  if (method === 'GET' && parts[0] === 'j' && parts.length === 2) return serveFile(res, 'player.html');
  if (method === 'GET' && parts[0] !== 'api') return serveFile(res, parts.join('/'));

  // API
  if (method === 'GET' && url.pathname === '/api/info') return json(res, 200, { lanUrls: lanUrls() });

  if (method === 'POST' && url.pathname === '/api/rooms') {
    const setup = parseSetup(await readBody(req));
    if (typeof setup === 'string') return json(res, 400, { error: setup });
    const room = { code: newCode(), gmToken: crypto.randomBytes(18).toString('base64url'), nextSeatId: 1 };
    dealRound(room, setup);
    rooms.set(room.code, room);
    scheduleSave();
    return json(res, 201, { code: room.code, gmToken: room.gmToken });
  }

  if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) return json(res, 404, { error: 'Not found' });
  const room = rooms.get(parts[2].toUpperCase());
  if (!room) return json(res, 404, { error: 'That game does not exist any more. Ask the game master for a new QR code.' });
  normalise(room);
  room.touched = Date.now();
  const action = parts.slice(3).join('/');

  // QR code for the join link. The page passes the base URL it wants phones to use.
  if (method === 'GET' && action === 'qr.svg') {
    const base = (url.searchParams.get('base') || '').replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(base)) return json(res, 400, { error: 'Bad base URL' });
    const svg = await QRCode.toString(`${base}/j/${room.code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }

  // --- game master ---
  if (method === 'GET' && action === 'gm') {
    if (!isGm(room, req)) return json(res, 403, { error: 'Not the game master' });
    return json(res, 200, gmView(room));
  }

  if (method === 'GET' && action === 'gm/events') {
    if (url.searchParams.get('token') !== room.gmToken) return json(res, 403, { error: 'Not the game master' });
    openStream(req, res);
    if (!gmStreams.has(room.code)) gmStreams.set(room.code, new Set());
    gmStreams.get(room.code).add(res);
    send(res, gmView(room));
    req.on('close', () => gmStreams.get(room.code)?.delete(res));
    return;
  }

  if (method === 'POST' && action === 'deal') {
    const body = await readBody(req);
    if (!isGm(room, req, body)) return json(res, 403, { error: 'Not the game master' });
    const setup = parseSetup({ ...room, ...body });
    if (typeof setup === 'string') return json(res, 400, { error: setup });
    dealRound(room, setup);
    broadcast(room);
    return json(res, 200, gmView(room));
  }

  if (method === 'POST' && action === 'kick') {
    const body = await readBody(req);
    if (!isGm(room, req, body)) return json(res, 403, { error: 'Not the game master' });
    if (room.phase !== 'lobby') return json(res, 409, { error: 'The game has started. Deal a new round to change who is playing.' });
    const idx = room.seats.findIndex((s) => s.id === body.seatId);
    if (idx === -1) return json(res, 404, { error: 'No such player' });
    const [seat] = room.seats.splice(idx, 1);
    room.deck.push(seat.role); // their card goes back into the deck
    shuffle(room.deck);
    broadcast(room);
    return json(res, 200, gmView(room));
  }

  // --- game phases (game master only) ---
  const PHASE_ACTIONS = ['start', 'night', 'day', 'vote', 'sleep', 'undo'];
  if (method === 'POST' && PHASE_ACTIONS.includes(action)) {
    const body = await readBody(req);
    if (!isGm(room, req, body)) return json(res, 403, { error: 'Not the game master' });
    const result = runPhaseAction(room, action, body);
    if (typeof result === 'string') return json(res, 409, { error: result });
    broadcast(room);
    return json(res, 200, gmView(room));
  }

  // --- feedback ("letters to the editor"), from players or the host ---
  if (method === 'POST' && action === 'feedback') {
    const body = await readBody(req);
    const gm = isGm(room, req, body);
    const token = gm ? `gm:${room.gmToken}` : String(body.token || '');
    if (!gm && (token.length < 16 || token.length > 64)) return json(res, 400, { error: 'Bad player token' });
    const seat = gm ? null : seatOf(room, token);
    const clip = (v) => String(v || '').trim().slice(0, 600);
    const again = ['yes', 'maybe', 'no'].includes(body.again) ? body.again : '';
    const letter = {
      token,
      at: Date.now(),
      round: room.round,
      from: gm ? 'host' : 'player',
      name: gm ? 'Host' : seat ? seat.name : 'A guest',
      again,
      slowed: clip(body.slowed),
      inTheWay: clip(body.inTheWay),
      wish: clip(body.wish),
    };
    if (!letter.again && !letter.slowed && !letter.inTheWay && !letter.wish) {
      return json(res, 400, { error: 'Answer at least one question before sending.' });
    }
    // One letter per phone per round; sending again replaces it.
    room.feedback = room.feedback.filter((f) => !(f.token === token && f.round === room.round));
    room.feedback.push(letter);
    if (room.feedback.length > 200) room.feedback.shift();
    forwardFeedback(room, letter);
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  // --- players ---
  if (method === 'GET' && action === 'me') {
    return json(res, 200, playerView(room, url.searchParams.get('token') || ''));
  }

  if (method === 'GET' && action === 'events') {
    const token = url.searchParams.get('token') || '';
    openStream(req, res);
    if (!playerStreams.has(room.code)) playerStreams.set(room.code, new Map());
    const byToken = playerStreams.get(room.code);
    if (!byToken.has(token)) byToken.set(token, new Set());
    byToken.get(token).add(res);
    send(res, playerView(room, token));
    req.on('close', () => {
      const set = byToken.get(token);
      set?.delete(res);
      if (set && set.size === 0) byToken.delete(token);
    });
    return;
  }

  if (method === 'POST' && action === 'join') {
    const body = await readBody(req);
    const token = String(body.token || '');
    if (token.length < 16 || token.length > 64) return json(res, 400, { error: 'Bad player token' });
    // A phone that already has a seat gets the same role back (refreshes, re-scans).
    if (seatOf(room, token)) return json(res, 200, playerView(room, token));
    if (room.phase !== 'lobby') {
      return json(res, 409, { error: 'This game has already started. Ask the host to deal you into the next round.' });
    }
    const name = cleanName(body.name);
    if (!name) return json(res, 400, { error: 'Please enter your name.' });
    if (room.seats.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      return json(res, 409, { error: `Someone already joined as "${name}". Add an initial or nickname.` });
    }
    if (room.deck.length === 0) {
      return json(res, 409, { error: `All ${room.players} roles have been dealt. Ask the game master if you should be playing.` });
    }
    room.seats.push({ id: room.nextSeatId++, token, name, role: room.deck.pop(), joinedAt: Date.now() });
    broadcast(room);
    return json(res, 200, playerView(room, token));
  }

  return json(res, 404, { error: 'Not found' });
}

loadRooms();
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong' });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Mafia role dealer running on http://localhost:${PORT}`);
    for (const u of lanUrls()) console.log(`  Phones on the same Wi-Fi can use: ${u}`);
  });
}

module.exports = { server, ROLES };
