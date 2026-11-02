const byId = id => document.getElementById(id);
const SESSION_KEY = 'darcuo-session';
const NAME_KEY = 'darcuo-name';
const SOUND_KEY = 'darcuo-sound';
const NOTIFICATION_KEY = 'darcuo-notifications';
const COUNTER_KEY = 'darcuo-counter-open';
const AUDIO_RESUME_TIMEOUT_MS = 1800;
const selected = new Set();
let state = null;
let sessionToken = null;
let eventSource = null;
let busy = false;
let toastTimer = null;
let hintMoves = [];
let hintIndex = 0;
let hintKey = '';
let serverOffset = 0;
let connected = false;
let soundEnabled = storageGet(SOUND_KEY) !== 'false';
let notificationsEnabled = storageGet(NOTIFICATION_KEY) === 'true';
let audioContext = null;
let audioIssue = '';
let titleTimer = null;
let titleFlashing = false;
const originalTitle = document.title;
let turnNotification = null;

function storageGet(key) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}
function storageSet(key, value) {
  try { if (value === null) { localStorage.removeItem(key); } else { localStorage.setItem(key, value); } }
  catch { /* Private browser modes can disable persistent storage. The current session still works. */ }
}
function toast(message) {
  clearTimeout(toastTimer);
  byId('toast').textContent = message;
  byId('toast').hidden = false;
  toastTimer = setTimeout(() => { byId('toast').hidden = true; }, 3600);
}
function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function connectionStatus(online, text) {
  byId('connection-dot').classList.toggle('offline', !online);
  byId('connection-label').textContent = text;
}
async function initializeAudio() {
  if (!soundEnabled) { return false; }
  if (!audioContext || audioContext.state === 'closed') {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) { audioIssue = 'Audio unavailable. Try Chrome or Edge.'; return false; }
    try { audioContext = new AudioContextClass(); }
    catch (error) { console.warn('Audio output unavailable:', error.name); audioIssue = 'Check audio output.'; return false; }
  }
  let resumeTimer;
  try {
    if (audioContext.state !== 'running') {
      await Promise.race([
        audioContext.resume(),
        new Promise((resolve, reject) => { resumeTimer = setTimeout(() => reject(new Error('Audio resume timed out')), AUDIO_RESUME_TIMEOUT_MS); })
      ]);
    }
    audioIssue = audioContext.state === 'running' ? '' : 'Click Test sound.';
  } catch (error) {
    console.warn('Audio resume unavailable:', error.name);
    audioIssue = 'Allow site audio, then retry.';
  } finally { clearTimeout(resumeTimer); }
  return soundEnabled && audioContext.state === 'running';
}
function tone(frequency, start, duration, volume = 0.16, type = 'sine') {
  if (!soundEnabled || !audioContext || audioContext.state !== 'running') { return; }
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const onset = audioContext.currentTime + start;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, onset);
  gain.gain.setValueAtTime(0.001, onset);
  gain.gain.exponentialRampToValueAtTime(volume, onset + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, onset + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(onset);
  oscillator.stop(onset + duration + 0.015);
}
async function playSound(name) {
  if (!await initializeAudio()) { return false; }
  const cues = {
    card: [[520, 0, 0.16]],
    pass: [[310, 0, 0.18]],
    bid: [[430, 0, 0.17], [610, 0.15, 0.22]],
    bomb: [[330, 0, 0.16, 0.12, 'triangle'], [500, 0.13, 0.16, 0.12, 'triangle'], [760, 0.26, 0.28, 0.14, 'triangle']],
    turn: [[660, 0, 0.2], [880, 0.22, 0.28]],
    test: [[440, 0, 0.24], [660, 0.26, 0.24], [880, 0.52, 0.32]]
  };
  for (const [frequency, start, duration, volume, type] of cues[name] || []) {
    tone(frequency, start, duration, volume, type);
  }
  return true;
}
function updatePreferenceButton(id, label, enabled) {
  const button = byId(id);
  button.classList.toggle('preference-on', enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', `${label}: ${enabled ? 'on' : 'off'}`);
  button.title = `${label}: ${enabled ? 'on' : 'off'}. Click to toggle.`;
}
function updatePreferenceButtons() {
  updatePreferenceButton('sound-toggle', 'Sound', soundEnabled);
  updatePreferenceButton('notification-toggle', 'Alerts', notificationsEnabled);
}
function clearTitleFlash() {
  clearInterval(titleTimer);
  titleTimer = null;
  titleFlashing = false;
  document.title = originalTitle;
  turnNotification?.close();
  turnNotification = null;
}
function notifyTurn() {
  if (!notificationsEnabled || !state || state.turn !== state.you || !['playing', 'bidding'].includes(state.phase)) { return; }
  const message = state.phase === 'bidding' ? 'Your bid.' : 'Your turn.';
  if (document.visibilityState === 'visible') {
    toast(message);
    return;
  }
  if ('Notification' in window && Notification.permission === 'granted' && window.isSecureContext) {
    try {
      turnNotification?.close();
      turnNotification = new Notification(`DARCUO · ${message}`, { body: `Room ${state.code}`, tag: `darcuo-${state.code}` });
      turnNotification.onclick = () => { window.focus(); clearTitleFlash(); };
    } catch (error) { console.warn('System notification unavailable:', error.name); }
  }
  if (titleTimer) { return; }
  titleTimer = setInterval(() => {
    titleFlashing = !titleFlashing;
    document.title = titleFlashing ? `Your turn · ${originalTitle}` : originalTitle;
  }, 900);
}
async function enableBrowserNotifications() {
  if (!('Notification' in window)) {
    toast('Tab alerts only.');
    return;
  }
  if (!window.isSecureContext) {
    toast('Tab alerts only.');
    return;
  }
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); }
    catch { toast('Tab alerts only.'); }
  }
  if (Notification.permission === 'denied') {
    toast('Notifications blocked. Tab alerts on.');
  } else if (Notification.permission === 'granted') {
    toast('Alerts on.');
  }
}
async function api(action, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
      body: JSON.stringify(payload), signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) { throw Object.assign(new Error(result.error || 'Try again.'), { status: response.status }); }
    return result;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') { throw new Error('Connection lost. Retry.'); }
    throw error;
  } finally { clearTimeout(timer); }
}
async function withBusy(task) {
  if (busy) { return; }
  busy = true;
  if (state) { renderActions(); } else { toggleEntryButtons(true); }
  try { await task(); }
  catch (error) { toast(error.message); }
  finally {
    busy = false;
    if (state) { renderActions(); } else { toggleEntryButtons(false); }
  }
}
function toggleEntryButtons(disabled) {
  for (const id of ['create-button', 'join-button', 'practice-button']) { byId(id).disabled = disabled; }
}
function readName() {
  const name = byId('nickname').value.trim();
  if (!name || [...name].length > 12) { byId('nickname').focus(); throw new Error('Name: 1–12 characters.'); }
  storageSet(NAME_KEY, name);
  return name;
}
function setEntryTab(join) {
  byId('create-tab').classList.toggle('active', !join);
  byId('join-tab').classList.toggle('active', join);
  byId('create-tab').setAttribute('aria-selected', String(!join));
  byId('join-tab').setAttribute('aria-selected', String(join));
  byId('create-panel').hidden = join;
  byId('join-panel').hidden = !join;
}
function enterRoom(result) {
  eventSource?.close();
  sessionToken = result.token || sessionToken;
  storageSet(SESSION_KEY, sessionToken);
  applyState(result.state);
  connectionStatus(false, 'Connecting');
  eventSource = new EventSource(`/events?token=${encodeURIComponent(sessionToken)}`);
  eventSource.onopen = () => { connected = true; connectionStatus(true, 'Connected'); renderActions(); };
  eventSource.onmessage = event => {
    const data = JSON.parse(event.data);
    connected = true;
    connectionStatus(true, 'Connected');
    applyState(data);
  };
  eventSource.onerror = () => {
    connected = false;
    connectionStatus(false, 'Reconnecting');
    renderActions();
    // A missing server-side session cannot be recovered by SSE retries alone.
    void api('resume').catch(error => {
      if (error.status === 401) { exitRoom(); toast('Session expired. Rejoin.'); }
    });
  };
}
function applyState(next) {
  const previous = state;
  const oldRound = state?.round;
  const oldTurn = state?.turn;
  state = next;
  updatePreferenceButtons();
  if (previous?.code === state.code) {
    const seenEvents = new Set(previous.log.map(entry => entry.id));
    const freshEvents = state.log.filter(entry => !seenEvents.has(entry.id));
    const latestSound = freshEvents.reverse().find(entry => entry.sound)?.sound;
    if (latestSound) { void playSound(latestSound); }
  }
  if (previous && previous.code === state.code && previous.you === state.you && state.turn === state.you &&
    (previous.turn !== state.you || previous.phase !== state.phase || previous.round !== state.round) && ['playing', 'bidding'].includes(state.phase)) {
    void playSound('turn');
    notifyTurn();
  }
  if (state.turn !== state.you || !['playing', 'bidding'].includes(state.phase)) { clearTitleFlash(); }
  serverOffset = next.serverTime - Date.now();
  const handIds = new Set(state.hand.map(card => card.id));
  for (const id of selected) { if (!handIds.has(id)) { selected.delete(id); } }
  if (oldRound !== state.round || oldTurn !== state.turn) { selected.clear(); }
  byId('lobby').hidden = true;
  byId('game').hidden = false;
  byId('room-number').textContent = state.code;
  byId('practice-badge').hidden = !state.practice;
  byId('copy-room').hidden = state.practice;
  byId('round-label').textContent = state.round ? `Round ${state.round}` : 'Waiting';
  byId('multiplier').textContent = `×${state.multiplier}`;
  renderBoard();
  renderPlayers();
  renderHand();
  renderCounter();
  renderActions();
  renderLog();
  updateClock();
}
function exitRoom() {
  clearTitleFlash();
  eventSource?.close(); eventSource = null;
  storageSet(SESSION_KEY, null);
  sessionToken = null; state = null; connected = false;
  selected.clear(); hintMoves = []; hintKey = '';
  byId('game').hidden = true;
  byId('lobby').hidden = false;
  connectionStatus(true, 'LAN');
  history.replaceState(null, '', '/');
}
function cardNode(card, mini = false, selectable = false) {
  const node = element(selectable ? 'button' : 'div', `card${card.red ? ' red' : ''}${card.rank >= 16 ? ' joker' : ''}${mini ? ' mini' : ''}`);
  node.append(element('span', 'rank', card.label), element('span', 'suit', card.suit));
  node.append(element('span', 'card-bottom', card.rank >= 16 ? '★' : card.suit));
  if (selectable) {
    node.type = 'button';
    node.dataset.id = card.id;
    node.setAttribute('aria-label', `${card.rank >= 16 ? '' : card.suit}${card.label}`);
    node.setAttribute('aria-pressed', String(selected.has(card.id)));
    node.classList.toggle('selected', selected.has(card.id));
  }
  return node;
}
function appendCards(container, cards, mini = true) {
  container.replaceChildren(...cards.map(card => cardNode(card, mini)));
}
function playerStatus(player) {
  if (!player.online) { return 'Offline'; }
  if (state.phase === 'waiting' || state.phase === 'finished') { return player.ready ? 'Ready' : 'Not ready'; }
  if (state.phase === 'bidding') { return player.bid === null ? 'Waiting' : player.bid ? `Bid ${player.bid}` : 'Pass'; }
  return state.turn === player.seat ? 'Playing' : 'Waiting';
}
function roleNode(seat) {
  const landlord = state.landlord === seat;
  return element('span', `role${landlord ? ' landlord' : ''}`, state.landlord === null ? (state.host === seat ? 'Host' : 'Player') : landlord ? 'Solo' : 'Team');
}
function renderOpponent(container, seat) {
  container.replaceChildren();
  const player = state.players[seat];
  container.classList.toggle('active', Boolean(player && state.turn === seat && ['bidding', 'playing'].includes(state.phase)));
  if (!player) {
    const heading = element('div', 'player-heading');
    const info = element('div');
    info.append(element('div', 'player-name', 'Open seat'), element('div', 'player-state', 'Waiting'));
    heading.append(element('div', 'player-avatar waiting-seat', '+'), info);
    container.append(heading);
    return;
  }
  const heading = element('div', 'player-heading');
  const info = element('div');
  info.append(element('div', 'player-name', player.name), element('div', `player-state${player.ready ? ' ready' : ''}`, playerStatus(player)));
  heading.append(element('div', 'player-avatar', player.bot ? '♙' : [...player.name][0]), info);
  const meta = element('div', 'player-meta');
  meta.append(roleNode(seat), element('span', '', `${player.score > 0 ? '+' : ''}${player.score} pts`));
  container.append(heading, meta);
  if (['playing', 'bidding'].includes(state.phase)) {
    const remaining = element('div', `remaining${player.count <= 2 ? ' warning' : ''}`);
    remaining.append(element('span', 'card-back'), element('span', '', String(player.count)));
    remaining.setAttribute('aria-label', `${player.count} left`);
    container.append(remaining);
  }
  if (state.phase === 'finished' && player.cards.length) {
    const revealed = element('div', 'revealed-hand');
    appendCards(revealed, player.cards);
    container.append(revealed);
  }
}
function renderPlayers() {
  renderOpponent(byId('opponent-left'), (state.you + 2) % 3);
  renderOpponent(byId('opponent-right'), (state.you + 1) % 3);
  const player = state.players[state.you];
  byId('self-info').replaceChildren(
    element('span', 'self-name', player.name), element('span', 'you-tag', 'You'), roleNode(state.you),
    element('span', 'score-text', `${player.score > 0 ? '+' : ''}${player.score} pts`)
  );
}
function renderPlayed(container, play) {
  container.replaceChildren();
  if (!play || state.phase === 'finished') { return; }
  if (!play.cards.length) { container.append(element('span', 'pass-label', play.text)); return; }
  const cards = element('div', 'play-cards');
  appendCards(cards, play.cards);
  container.append(cards, element('span', 'play-label', play.text));
}
function renderBoard() {
  if (state.bottom.length) { appendCards(byId('bottom-cards'), state.bottom); }
  else { byId('bottom-cards').replaceChildren(...Array.from({ length: 3 }, () => element('span', 'card-back'))); }
  renderPlayed(byId('left-play'), state.table[(state.you + 2) % 3]);
  renderPlayed(byId('right-play'), state.table[(state.you + 1) % 3]);
  renderPlayed(byId('self-play'), state.table[state.you]);
  const center = byId('center-status');
  center.replaceChildren();
  if (state.phase === 'waiting') {
    const count = state.players.filter(Boolean).length;
    center.append(element('h2', '', count < 3 ? 'Waiting' : 'Ready up'), element('p', '', count < 3 ? `${count} / 3 joined` : 'Host starts when all ready.'));
  } else if (state.phase === 'bidding') {
    center.append(element('h2', '', 'Bidding'), element('p', '', state.bid ? `Top bid: ${state.bid}` : 'Choose a bid.'));
  } else if (state.phase === 'finished') {
    const won = state.result.changes[state.you] > 0;
    const delta = state.result.changes[state.you];
    center.append(element('h2', '', won ? 'You win.' : 'Next time.'),
      element('p', 'result-line', `${state.result.landlordWon ? 'Solo' : 'Team'} wins`),
      element('div', `result-score${delta < 0 ? ' negative' : ''}`, `${delta > 0 ? '+' : ''}${delta}`));
    if (state.result.spring) { center.append(element('small', '', 'Sweep ×2')); }
  }
}
function renderHand() {
  const hand = byId('hand');
  if (!state.hand.length) {
    const empty = element('div', 'hand-empty');
    empty.append(element('span', '', '♠'), element('div', '', state.phase === 'finished' ? 'All done.' : 'Ready when you are.'));
    hand.replaceChildren(empty);
  } else { hand.replaceChildren(...state.hand.map(card => cardNode(card, false, true))); }
  updateSelection();
}
function updateSelection() {
  byId('selection-label').textContent = state.hand.length ? `${state.hand.length} cards${selected.size ? ` · ${selected.size} selected` : ''}` : state.phase === 'finished' ? 'Finished' : 'Waiting';
  for (const node of byId('hand').querySelectorAll('button')) {
    node.classList.toggle('selected', selected.has(node.dataset.id));
    node.setAttribute('aria-pressed', String(selected.has(node.dataset.id)));
  }
  const button = byId('play-button');
  if (button) { button.disabled = busy || !connected || selected.size === 0; }
}
function renderCounter() {
  const panel = byId('card-counter');
  panel.hidden = !['playing', 'finished'].includes(state.phase);
  if (panel.hidden) { return; }
  const grid = byId('counter-grid');
  grid.replaceChildren();
  if (!Array.isArray(state.playedCards)) {
    byId('counter-total').textContent = 'Update needed';
    byId('counter-note').textContent = 'Restart host after this round.';
    return;
  }
  const ranks = Array.from({ length: 15 }, (value, index) => 17 - index);
  const remaining = new Map(ranks.map(rank => [rank, rank >= 16 ? 1 : 4]));
  for (const card of [...state.hand, ...state.playedCards]) { remaining.set(card.rank, remaining.get(card.rank) - 1); }
  const labels = { 17: 'BJ', 16: 'SJ', 15: '2', 14: 'A', 13: 'K', 12: 'Q', 11: 'J' };
  let total = 0;
  for (const rank of ranks) {
    const count = remaining.get(rank);
    total += count;
    const item = element('div', `counter-item${count === 0 ? ' empty' : ''}`);
    item.dataset.rank = rank;
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', `${labels[rank] || rank}: ${count} left`);
    item.append(element('span', 'counter-rank', labels[rank] || String(rank)), element('span', 'counter-count', String(count)));
    grid.append(item);
  }
  byId('counter-total').textContent = `${total} remaining`;
  byId('counter-note').textContent = 'Other players combined.';
}
function actionButton(text, className, action, disabled = false, id = '') {
  const button = element('button', `button ${className}`, text);
  button.type = 'button';
  button.disabled = busy || !connected || disabled;
  if (id) { button.id = id; }
  button.addEventListener('click', () => { void withBusy(action); });
  return button;
}
async function perform(action, payload) {
  const result = await api(action, payload);
  if (result.state) { applyState(result.state); }
}
function renderActions() {
  const bar = byId('action-bar');
  bar.replaceChildren();
  if (!state) { return; }
  const player = state.players[state.you];
  if (['waiting', 'finished'].includes(state.phase)) {
    bar.append(actionButton(player.ready ? 'Unready' : 'Ready', player.ready ? 'secondary' : 'primary', () => perform('ready', { ready: !player.ready })));
    if (state.host === state.you) {
      const allReady = state.players.every(entry => entry?.ready && entry.online);
      bar.append(actionButton('Start', 'primary', () => perform('start'), !allReady));
    } else { bar.append(element('span', 'action-note', 'Wait for host.')); }
    return;
  }
  if (state.turn !== state.you) {
    bar.append(element('span', 'action-note', `Waiting: ${state.players[state.turn].name}`));
    return;
  }
  if (state.phase === 'bidding') {
    bar.append(actionButton('Pass', 'secondary', () => perform('bid', { value: 0 })));
    for (const value of [1, 2, 3]) { bar.append(actionButton(`${value}`, value === 3 ? 'primary' : 'secondary', () => perform('bid', { value }), value <= state.bid)); }
    return;
  }
  bar.append(actionButton('Pass', 'secondary', () => perform('pass'), !state.lastPlay));
  bar.append(actionButton('Hint', 'hint', showHint));
  bar.append(actionButton('Clear', 'secondary', async () => { selected.clear(); updateSelection(); }));
  bar.append(actionButton('Play', 'primary', async () => {
    await perform('play', { ids: [...selected] });
    selected.clear(); updateSelection();
  }, selected.size === 0, 'play-button'));
  byId('hand-help').textContent = state.canBeat ? 'Select cards, then Play.' : 'No match. Pass.';
}
async function showHint() {
  const key = `${state.round}/${state.turn}/${state.hand.map(card => card.id).join(',')}/${state.lastPlay?.cards.map(card => card.id).join(',') || ''}`;
  if (key !== hintKey) {
    hintMoves = (await api('hint')).moves;
    hintKey = key; hintIndex = 0;
  }
  selected.clear();
  if (!hintMoves.length) { updateSelection(); toast('No match. Pass.'); return; }
  for (const id of hintMoves[hintIndex % hintMoves.length]) { selected.add(id); }
  hintIndex++;
  updateSelection();
}
function renderLog() {
  const list = byId('game-log');
  list.replaceChildren(...state.log.map(entry => element('li', '', entry.message)));
  list.scrollTop = list.scrollHeight;
}
function updateClock() {
  if (!state) { return; }
  const clock = byId('countdown');
  const active = ['playing', 'bidding'].includes(state.phase);
  if (!active) {
    clock.textContent = '';
    byId('turn-status').textContent = state.phase === 'finished' ? 'Ready for next.' : 'LAN · Points only';
    return;
  }
  const seconds = Math.max(0, Math.ceil((state.deadline - Date.now() - serverOffset) / 1000));
  clock.textContent = `${String(seconds).padStart(2, '0')}s`;
  clock.classList.toggle('urgent', seconds <= 8);
  byId('turn-status').textContent = `${state.turn === state.you ? 'Your turn' : state.players[state.turn].name}${state.phase === 'bidding' ? ' · Bid' : ''}${state.phase === 'playing' && !state.lastPlay ? ' · Lead' : ''}`;
}
async function copyInvite() {
  const addressInfo = await fetch('/api/info').then(response => response.json());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const base = local ? addressInfo.addresses[0] || location.origin : location.origin;
  const invite = `${base}/?room=${state.code}`;
  const text = `DARCUO: ${invite}\nRoom: ${state.code}\nSame LAN required.`;
  try {
    if (!navigator.clipboard?.writeText) { throw new Error('Clipboard unavailable'); }
    await navigator.clipboard.writeText(text);
    toast('Invite copied.');
  } catch {
    const input = element('textarea', 'sr-only', text);
    document.body.append(input); input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (copied) { toast('Invite copied.'); }
    else { toast(`${base} · ${state.code}`); }
  }
}

byId('nickname').value = storageGet(NAME_KEY) || '';
updatePreferenceButtons();
document.addEventListener('pointerdown', () => { void initializeAudio(); });
document.addEventListener('keydown', () => { void initializeAudio(); });
byId('sound-toggle').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  storageSet(SOUND_KEY, String(soundEnabled));
  updatePreferenceButtons();
  if (soundEnabled) { void playSound('turn'); }
  else if (audioContext) { void audioContext.suspend().catch(() => {}); }
  byId('sound-status').textContent = soundEnabled ? 'Click Test sound.' : 'Sound off.';
  toast(`Sound ${soundEnabled ? 'on' : 'off'}.`);
});
byId('sound-test').addEventListener('click', () => {
  void (async () => {
    const button = byId('sound-test');
    button.disabled = true;
    soundEnabled = true;
    storageSet(SOUND_KEY, 'true');
    updatePreferenceButtons();
    byId('sound-status').textContent = 'Starting audio…';
    try {
      const played = await playSound('test');
      byId('sound-status').textContent = played ? 'Played. Check volume if silent.' : audioIssue;
    } catch (error) {
      console.warn('Sound test failed:', error.name);
      byId('sound-status').textContent = 'Audio failed. Check site settings.';
    } finally { button.disabled = false; }
  })();
});
byId('card-counter').open = storageGet(COUNTER_KEY) !== 'false';
byId('card-counter').addEventListener('toggle', () => { storageSet(COUNTER_KEY, String(byId('card-counter').open)); });
byId('notification-toggle').addEventListener('click', () => {
  notificationsEnabled = !notificationsEnabled;
  storageSet(NOTIFICATION_KEY, String(notificationsEnabled));
  updatePreferenceButtons();
  if (notificationsEnabled) { void enableBrowserNotifications(); }
  else { clearTitleFlash(); toast('Alerts off.'); }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const pending = titleTimer !== null;
    clearTitleFlash();
    if (pending) { notifyTurn(); }
  } else if (notificationsEnabled && state && state.turn === state.you && ['playing', 'bidding'].includes(state.phase)) {
    notifyTurn();
  }
});
byId('create-tab').addEventListener('click', () => setEntryTab(false));
byId('join-tab').addEventListener('click', () => setEntryTab(true));
byId('create-button').addEventListener('click', () => { void withBusy(async () => enterRoom(await api('create', { name: readName() }))); });
byId('practice-button').addEventListener('click', () => { void withBusy(async () => enterRoom(await api('create', { name: readName(), practice: true }))); });
byId('join-button').addEventListener('click', () => {
  void withBusy(async () => {
    const name = readName();
    const code = byId('room-code').value.trim();
    if (!/^\d{6}$/.test(code)) { byId('room-code').focus(); throw new Error('Enter a 6-digit code.'); }
    enterRoom(await api('join', { name, code }));
  });
});
byId('room-code').addEventListener('input', event => { event.target.value = event.target.value.replace(/[^0-9]/g, ''); });
byId('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') { byId('join-button').click(); } });
byId('nickname').addEventListener('keydown', event => { if (event.key === 'Enter') { byId('join-panel').hidden ? byId('create-button').click() : byId('room-code').focus(); } });
byId('copy-room').addEventListener('click', () => { void withBusy(copyInvite); });
byId('hand').addEventListener('click', event => {
  const card = event.target.closest('button[data-id]');
  if (!card || !state) { return; }
  if (!['playing', 'bidding'].includes(state.phase)) { return; }
  const id = card.dataset.id;
  if (selected.has(id)) { selected.delete(id); } else { selected.add(id); }
  updateSelection();
});
byId('rules-button').addEventListener('click', () => byId('rules-dialog').showModal());
byId('close-rules').addEventListener('click', () => byId('rules-dialog').close());
byId('leave-button').addEventListener('click', () => byId('leave-dialog').showModal());
byId('cancel-leave').addEventListener('click', () => byId('leave-dialog').close());
byId('confirm-leave').addEventListener('click', () => {
  void withBusy(async () => {
    await api('leave');
    byId('leave-dialog').close();
    exitRoom();
  });
});
document.addEventListener('keydown', event => {
  if (!state || event.target.matches('input,textarea,button') || document.querySelector('dialog[open]')) { return; }
  if (event.key === 'Escape') { selected.clear(); updateSelection(); }
  if (event.key === 'Enter') { event.preventDefault(); byId('play-button')?.click(); }
});
setInterval(updateClock, 250);

async function initialize() {
  const room = new URLSearchParams(location.search).get('room');
  if (/^\d{6}$/.test(room || '')) { setEntryTab(true); byId('room-code').value = room; }
  sessionToken = storageGet(SESSION_KEY);
  if (!sessionToken) { return; }
  await withBusy(async () => {
    try { enterRoom(await api('resume')); }
    catch (error) {
      sessionToken = null;
      if (error.status === 401) { storageSet(SESSION_KEY, null); }
      else { throw error; }
    }
  });
}
void initialize();
