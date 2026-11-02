import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import { PLAYER_COUNT, HAND_SIZE, shuffledDeck, sortCards, legalMoves, resolvePlay } from './game.mjs';

const PORT = Number(process.env.PORT || 3000);
const TURN_MS = 45000;
const BID_MS = 20000;
const RESERVE_MS = 120000;
const ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_ROOMS = 100;
const rooms = new Map();
const sessions = new Map();
const publicRoot = new URL('./public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const lanAddresses = [...new Set(Object.values(networkInterfaces()).flat().filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => `http://${entry.address}:${PORT}`))];

function token() { return randomBytes(24).toString('hex'); }
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function currentPlayer(room) { return room.players[room.turn]; }
function nextSeat(seat) { return (seat + 1) % PLAYER_COUNT; }
function log(room, message, sound = null) { room.log = [...room.log.slice(-29), { id: token().slice(0, 8), message, sound }]; }
function setTurn(room, seat) {
  room.turn = seat;
  room.deadline = Date.now() + (room.phase === 'bidding' ? BID_MS : TURN_MS);
  room.botAt = room.players[seat]?.bot ? Date.now() + 1100 : 0;
}
function view(room, player) {
  const reveal = room.phase === 'finished';
  const target = room.lastPlay && room.lastPlay.seat !== room.turn ? room.lastPlay.pattern : null;
  return {
    code: room.code, practice: room.practice, phase: room.phase, you: player.seat,
    host: room.host, turn: room.turn, deadline: room.deadline, serverTime: Date.now(),
    landlord: room.landlord, bid: room.bid, multiplier: room.multiplier, round: room.round,
    bottom: room.landlord === null ? [] : room.bottom,
    hand: sortCards(player.hand), lastPlay: room.lastPlay, table: room.table, playedCards: room.playedCards,
    winner: room.winner, result: room.result, log: room.log,
    canBeat: room.phase === 'playing' && room.turn === player.seat ? legalMoves(player.hand, target).length > 0 : false,
    players: room.players.map(entry => entry ? {
      seat: entry.seat, name: entry.name, ready: entry.ready, online: entry.online,
      bot: entry.bot, count: entry.hand.length, score: entry.score, bid: entry.bid,
      cards: reveal ? sortCards(entry.hand) : []
    } : null)
  };
}
function push(room) {
  room.updatedAt = Date.now();
  for (const player of room.players.filter(Boolean)) {
    const session = sessions.get(player.token);
    if (session?.stream && !session.stream.destroyed) {
      session.stream.write(`data: ${JSON.stringify(view(room, player))}\n\n`);
    }
  }
}
function newPlayer(name, seat, bot = false) {
  return { token: token(), name, seat, bot, online: true, offlineAt: 0, ready: bot, hand: [], score: 0, bid: null };
}
function bindSession(room, player) {
  sessions.set(player.token, { room, player, stream: null, requests: [] });
}
function makeRoom(name, practice) {
  if (rooms.size >= MAX_ROOMS) { fail('Server full. Try later.', 503); }
  let code;
  do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
  const room = {
    code, practice, host: 0, players: [newPlayer(name, 0), null, null],
    phase: 'waiting', turn: null, landlord: null, bottom: [], lastPlay: null, playedCards: [],
    table: [null, null, null], bid: 0, bidder: null, bidCount: 0, multiplier: 1,
    passes: 0, round: 0, log: [], winner: null, result: null, updatedAt: Date.now(), deadline: 0
  };
  if (practice) {
    room.players[1] = newPlayer('Bot N', 1, true);
    room.players[2] = newPlayer('Bot S', 2, true);
  }
  rooms.set(code, room);
  bindSession(room, room.players[0]);
  log(room, `${name} created room`);
  return room;
}
function requireSession(value) {
  const session = typeof value === 'string' ? sessions.get(value) : null;
  if (!session) { fail('Session expired. Rejoin.', 401); }
  return session;
}
function startRound(room) {
  const deck = shuffledDeck();
  room.phase = 'bidding';
  room.round++;
  room.landlord = null;
  room.bottom = deck.slice(HAND_SIZE * PLAYER_COUNT);
  room.bid = 0; room.bidder = null; room.bidCount = 0; room.multiplier = 1;
  room.lastPlay = null; room.passes = 0; room.table = [null, null, null];
  room.playedCards = [];
  room.winner = null; room.result = null;
  room.players.forEach((player, index) => {
    player.hand = sortCards(deck.slice(index * HAND_SIZE, (index + 1) * HAND_SIZE));
    player.bid = null; player.playCount = 0; player.ready = false;
  });
  setTurn(room, (room.round - 1) % PLAYER_COUNT);
  log(room, `Round ${room.round}: bid`);
}
function assignLandlord(room) {
  room.landlord = room.bidder;
  room.multiplier = room.bid;
  const player = room.players[room.landlord];
  player.hand = sortCards([...player.hand, ...room.bottom]);
  room.phase = 'playing';
  setTurn(room, room.landlord);
  log(room, `${player.name}: solo · ${room.bid}`);
}
function bid(room, player, value) {
  if (room.phase !== 'bidding' || room.turn !== player.seat) { fail('Wait your turn.'); }
  if (!Number.isInteger(value) || value < 0 || value > 3 || (value !== 0 && value <= room.bid)) { fail('Bid higher or pass.'); }
  player.bid = value;
  room.bidCount++;
  if (value > room.bid) { room.bid = value; room.bidder = player.seat; }
  log(room, `${player.name} ${value ? `bids ${value}` : 'passes'}`, 'bid');
  if (value === 3 || room.bidCount === PLAYER_COUNT) {
    if (room.bidder === null) { log(room, 'No bids. Redealing.'); startRound(room); }
    else { assignLandlord(room); }
    return;
  }
  setTurn(room, nextSeat(room.turn));
}
function finishRound(room, player) {
  room.phase = 'finished';
  room.deadline = 0; room.botAt = 0;
  room.winner = player.seat;
  const landlordWon = player.seat === room.landlord;
  const spring = landlordWon ? room.players.filter(entry => entry.seat !== room.landlord).every(entry => entry.playCount === 0) : room.players[room.landlord].playCount <= 1;
  if (spring) { room.multiplier *= 2; }
  room.result = { landlordWon, spring, changes: room.players.map(entry => {
    const sideWon = (entry.seat === room.landlord) === landlordWon;
    const delta = (sideWon ? 1 : -1) * room.multiplier * (entry.seat === room.landlord ? 2 : 1);
    entry.score += delta;
    entry.ready = entry.bot;
    return delta;
  }) };
  log(room, `${landlordWon ? 'Solo' : 'Team'} wins${spring ? ' · Sweep ×2' : ''}`);
}
function play(room, player, ids) {
  if (room.phase !== 'playing' || room.turn !== player.seat) { fail('Wait your turn.'); }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) { fail('Select cards.'); }
  const selected = ids.map(id => player.hand.find(card => card.id === id));
  if (selected.some(card => !card)) { fail('Invalid selection.'); }
  const target = room.lastPlay?.pattern || null;
  const resolved = resolvePlay(selected, target);
  if (!resolved) { fail(target ? 'Invalid play or too low.' : 'Invalid combination.'); }
  player.hand = player.hand.filter(card => !ids.includes(card.id));
  room.playedCards.push(...selected);
  player.playCount++;
  room.lastPlay = { seat: player.seat, cards: sortCards(selected), pattern: resolved };
  room.table[player.seat] = { cards: sortCards(selected), text: resolved.name };
  room.passes = 0;
  if (resolved.type === 'bomb' || resolved.type === 'rocket') { room.multiplier *= 2; }
  log(room, `${player.name}: ${resolved.name}${player.hand.length <= 2 ? ` · ${player.hand.length} left` : ''}`, resolved.type === 'bomb' || resolved.type === 'rocket' ? 'bomb' : 'card');
  if (player.hand.length === 0) { finishRound(room, player); return; }
  setTurn(room, nextSeat(room.turn));
  room.table[room.turn] = null;
}
function pass(room, player) {
  if (room.phase !== 'playing' || room.turn !== player.seat) { fail('Wait your turn.'); }
  if (!room.lastPlay || room.lastPlay.seat === player.seat) { fail('Play to lead.'); }
  room.table[player.seat] = { cards: [], text: 'Pass' };
  room.passes++;
  log(room, `${player.name} passes`, 'pass');
  if (room.passes === 2) {
    const leader = room.lastPlay.seat;
    room.lastPlay = null; room.passes = 0;
    room.table = [null, null, null];
    setTurn(room, leader);
    return;
  }
  setTurn(room, nextSeat(room.turn));
  room.table[room.turn] = null;
}
function automatedTurn(room) {
  const player = currentPlayer(room);
  if (room.phase === 'bidding') {
    const strength = player.hand.filter(card => card.rank >= 15).length + legalMoves(player.hand).filter(move => move.pattern.type === 'bomb').length;
    const value = player.bot && strength >= 3 && room.bid < 3 ? Math.min(3, Math.max(room.bid + 1, strength >= 5 ? 3 : 1)) : 0;
    bid(room, player, value);
  } else if (room.lastPlay) {
    const teammate = player.bot && player.seat !== room.landlord && room.lastPlay.seat !== room.landlord;
    const moves = player.bot && !teammate ? legalMoves(player.hand, room.lastPlay.pattern) : [];
    if (moves.length) { play(room, player, moves[0].cards.map(card => card.id)); }
    else { pass(room, player); }
  } else {
    const cards = player.bot ? legalMoves(player.hand)[0].cards : [player.hand.at(-1)];
    play(room, player, cards.map(card => card.id));
  }
}
function deleteRoom(room) {
  rooms.delete(room.code);
  for (const player of room.players.filter(Boolean)) {
    const session = sessions.get(player.token);
    if (session?.stream) { session.stream.end(); }
    sessions.delete(player.token);
  }
}
function removePlayer(room, player) {
  if (room.phase === 'playing' || room.phase === 'bidding') {
    room.phase = 'waiting'; room.deadline = 0; room.botAt = 0;
    room.landlord = null; room.bottom = []; room.lastPlay = null; room.table = [null, null, null]; room.playedCards = [];
    room.result = null; room.winner = null; room.turn = null; room.bid = 0; room.multiplier = 1;
    for (const entry of room.players.filter(Boolean)) { entry.hand = []; entry.ready = entry.bot; entry.bid = null; }
    log(room, 'Player left. Round cancelled.');
  }
  const session = sessions.get(player.token);
  sessions.delete(player.token);
  if (session?.stream) { session.stream.end(); }
  room.players[player.seat] = null;
  log(room, `${player.name} left`);
  const humans = room.players.filter(entry => entry && !entry.bot);
  if (humans.length === 0) { deleteRoom(room); return; }
  if (room.host === player.seat) { room.host = humans[0].seat; }
  push(room);
}
function validName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > 12 || /[\x00-\x1f\x7f]/.test(name)) { fail('Name: 1–12 characters.'); }
  return name;
}
async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 8192) { fail('Request too large.', 413); }
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('Invalid request.'); }
    return value;
  } catch (error) {
    if (error.status) { throw error; }
    fail('Invalid request.');
  }
}
function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
function rateLimit(session) {
  session.requests = session.requests.filter(time => time > Date.now() - 10000);
  if (session.requests.length >= 60) { fail('Slow down.', 429); }
  session.requests.push(Date.now());
}
async function api(request, response, path) {
  const body = await readBody(request);
  if (path === '/api/create') {
    const room = makeRoom(validName(body.name), body.practice === true);
    json(response, { token: room.players[0].token, state: view(room, room.players[0]) });
    return;
  }
  if (path === '/api/join') {
    const name = validName(body.name);
    const room = rooms.get(String(body.code));
    if (!room || room.practice) { fail('Room not found.', 404); }
    const seat = room.players.findIndex(player => !player);
    if (seat < 0) { fail('Room full.'); }
    if (room.players.some(player => player?.name === name)) { fail('Name taken.'); }
    const player = newPlayer(name, seat);
    room.players[seat] = player;
    bindSession(room, player);
    log(room, `${name} joined`);
    push(room);
    json(response, { token: player.token, state: view(room, player) });
    return;
  }
  const session = requireSession(request.headers.authorization?.replace(/^Bearer /, ''));
  const { room, player } = session;
  rateLimit(session);
  if (path === '/api/resume') { json(response, { state: view(room, player) }); return; }
  if (path === '/api/leave') { removePlayer(room, player); json(response, { ok: true }); return; }
  if (path === '/api/ready') {
    if (!['waiting', 'finished'].includes(room.phase)) { fail('Round in progress.'); }
    if (typeof body.ready !== 'boolean') { fail('Invalid ready state.'); }
    player.ready = body.ready;
  } else if (path === '/api/start') {
    if (room.host !== player.seat) { fail('Host only.'); }
    if (!['waiting', 'finished'].includes(room.phase)) { fail('Round in progress.'); }
    if (!room.players.every(entry => entry?.ready && entry.online)) { fail('All 3 must be ready.'); }
    startRound(room);
  } else if (path === '/api/bid') { bid(room, player, body.value); }
  else if (path === '/api/play') { play(room, player, body.ids); }
  else if (path === '/api/pass') { pass(room, player); }
  else if (path === '/api/hint') {
    if (room.phase !== 'playing' || room.turn !== player.seat) { fail('Wait your turn.'); }
    const moves = legalMoves(player.hand, room.lastPlay?.pattern || null);
    json(response, { moves: moves.slice(0, 80).map(move => move.cards.map(card => card.id)) });
    return;
  } else { fail('Unknown action.', 404); }
  push(room);
  json(response, { state: view(room, player) });
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) { fail('Invalid origin.', 403); }
      await api(request, response, url.pathname);
      return;
    }
    if (request.method !== 'GET') { fail('Method not allowed.', 405); }
    if (url.pathname === '/api/info') { json(response, { addresses: lanAddresses, port: PORT }); return; }
    if (url.pathname === '/events') {
      const session = requireSession(url.searchParams.get('token'));
      if (session.stream) { session.stream.end(); }
      session.stream = response;
      session.player.online = true; session.player.offlineAt = 0;
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      response.write('retry: 2000\n\n');
      const heartbeat = setInterval(() => { response.write(': heartbeat\n\n'); }, 15000);
      request.on('close', () => {
        clearInterval(heartbeat);
        if (session.stream !== response) { return; }
        session.stream = null;
        session.player.online = false; session.player.offlineAt = Date.now();
        if (rooms.has(session.room.code)) { push(session.room); }
      });
      push(session.room);
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset) { fail('Not found.', 404); }
    const content = await readFile(new URL(asset[0], publicRoot));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
    response.end(content);
  } catch (error) {
    if (!error.status) { console.error('Request failed:', error); }
    if (!response.headersSent) { json(response, { error: error.status ? error.message : 'Server error. Retry.' }, error.status || 500); }
    else { response.end(); }
  }
});

const maintenance = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const expired = room.players.filter(player => player && !player.bot && !player.online && player.offlineAt && now - player.offlineAt > RESERVE_MS);
    for (const player of expired) { if (rooms.has(room.code)) { removePlayer(room, player); } }
    if (!rooms.has(room.code)) { continue; }
    if (now - room.updatedAt > ROOM_TTL_MS && !room.players.some(player => player && !player.bot && player.online)) { deleteRoom(room); continue; }
    if (!['playing', 'bidding'].includes(room.phase)) { continue; }
    if (now >= room.deadline || (room.botAt && now >= room.botAt)) {
      try { automatedTurn(room); push(room); }
      catch (error) { console.error('Automatic turn failed in room %s:', room.code, error); room.botAt = 0; room.deadline = now + TURN_MS; }
    }
  }
}, 500);

server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} busy. Choose another PORT.` : error.message);
  clearInterval(maintenance);
  process.exitCode = 1;
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  DARCUO\n  Local: http://localhost:${PORT}\n${lanAddresses.map(address => `  LAN: ${address}`).join('\n')}\n\n  Share the LAN URL and room code.\n  Keep this window open. Ctrl+C to stop.\n`);
});
function shutdown() {
  clearInterval(maintenance);
  for (const session of sessions.values()) { session.stream?.end(); }
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
