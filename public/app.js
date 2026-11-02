const byId = id => document.getElementById(id);
const SESSION_KEY = 'darcuo-session';
const NAME_KEY = 'darcuo-name';
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
async function api(action, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
      body: JSON.stringify(payload), signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) { throw Object.assign(new Error(result.error || '操作失败，请重试。'), { status: response.status }); }
    return result;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') { throw new Error('暂时连接不到服务，请检查网络后重试。'); }
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
  if (!name || [...name].length > 12) { byId('nickname').focus(); throw new Error('先输入一个 1–12 个字符的昵称吧。'); }
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
  connectionStatus(false, '正在连接');
  eventSource = new EventSource(`/events?token=${encodeURIComponent(sessionToken)}`);
  eventSource.onopen = () => { connected = true; connectionStatus(true, '已连接牌桌'); renderActions(); };
  eventSource.onmessage = event => {
    const data = JSON.parse(event.data);
    connected = true;
    connectionStatus(true, '已连接牌桌');
    applyState(data);
  };
  eventSource.onerror = () => {
    connected = false;
    connectionStatus(false, '断线重连中');
    renderActions();
    // A missing server-side session cannot be recovered by SSE retries alone.
    void api('resume').catch(error => {
      if (error.status === 401) { exitRoom(); toast('房间已失效，请重新创建或加入。'); }
    });
  };
}
function applyState(next) {
  const oldRound = state?.round;
  const oldTurn = state?.turn;
  state = next;
  serverOffset = next.serverTime - Date.now();
  const handIds = new Set(state.hand.map(card => card.id));
  for (const id of selected) { if (!handIds.has(id)) { selected.delete(id); } }
  if (oldRound !== state.round || oldTurn !== state.turn) { selected.clear(); }
  byId('lobby').hidden = true;
  byId('game').hidden = false;
  byId('room-number').textContent = state.code;
  byId('practice-badge').hidden = !state.practice;
  byId('copy-room').hidden = state.practice;
  byId('round-label').textContent = state.round ? `第 ${state.round} 局` : '等待开局';
  byId('multiplier').textContent = `×${state.multiplier}`;
  renderBoard();
  renderPlayers();
  renderHand();
  renderActions();
  renderLog();
  updateClock();
}
function exitRoom() {
  eventSource?.close(); eventSource = null;
  storageSet(SESSION_KEY, null);
  sessionToken = null; state = null; connected = false;
  selected.clear(); hintMoves = []; hintKey = '';
  byId('game').hidden = true;
  byId('lobby').hidden = false;
  connectionStatus(true, '局域网联机');
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
  if (!player.online) { return '离线 · 保留座位'; }
  if (state.phase === 'waiting' || state.phase === 'finished') { return player.ready ? '已准备' : '未准备'; }
  if (state.phase === 'bidding') { return player.bid === null ? '等待叫分' : player.bid ? `叫 ${player.bid} 分` : '不叫'; }
  return state.turn === player.seat ? '正在出牌' : '思考中';
}
function roleNode(seat) {
  const landlord = state.landlord === seat;
  return element('span', `role${landlord ? ' landlord' : ''}`, state.landlord === null ? (state.host === seat ? '房主' : '玩家') : landlord ? '地主' : '农民');
}
function renderOpponent(container, seat) {
  container.replaceChildren();
  const player = state.players[seat];
  container.classList.toggle('active', Boolean(player && state.turn === seat && ['bidding', 'playing'].includes(state.phase)));
  if (!player) {
    const heading = element('div', 'player-heading');
    const info = element('div');
    info.append(element('div', 'player-name', '空座位'), element('div', 'player-state', '等待朋友加入'));
    heading.append(element('div', 'player-avatar waiting-seat', '+'), info);
    container.append(heading);
    return;
  }
  const heading = element('div', 'player-heading');
  const info = element('div');
  info.append(element('div', 'player-name', player.name), element('div', `player-state${player.ready ? ' ready' : ''}`, playerStatus(player)));
  heading.append(element('div', 'player-avatar', player.bot ? '♙' : [...player.name][0]), info);
  const meta = element('div', 'player-meta');
  meta.append(roleNode(seat), element('span', '', `${player.score > 0 ? '+' : ''}${player.score} 分`));
  container.append(heading, meta);
  if (['playing', 'bidding'].includes(state.phase)) {
    const remaining = element('div', `remaining${player.count <= 2 ? ' warning' : ''}`);
    remaining.append(element('span', 'card-back'), element('span', '', String(player.count)));
    remaining.setAttribute('aria-label', `剩余 ${player.count} 张牌`);
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
    element('span', 'self-name', player.name), element('span', 'you-tag', '你'), roleNode(state.you),
    element('span', 'score-text', `${player.score > 0 ? '+' : ''}${player.score} 积分`)
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
    center.append(element('h2', '', count < 3 ? '等朋友入座' : '人齐了，准备开局'), element('p', '', count < 3 ? `已入座 ${count} / 3 · 分享房间号邀请朋友` : '所有人准备后，由房主开始游戏'));
  } else if (state.phase === 'bidding') {
    center.append(element('h2', '', '叫地主'), element('p', '', state.bid ? `当前最高 ${state.bid} 分` : '好牌在手，就叫一分'));
  } else if (state.phase === 'finished') {
    const won = state.result.changes[state.you] > 0;
    const delta = state.result.changes[state.you];
    center.append(element('h2', '', won ? '这一局，赢得漂亮。' : '好牌，留给下一局。'),
      element('p', 'result-line', `${state.result.landlordWon ? '地主' : '农民'}获胜`),
      element('div', `result-score${delta < 0 ? ' negative' : ''}`, `${delta > 0 ? '+' : ''}${delta}`));
    if (state.result.spring) { center.append(element('small', '', '春天 · 倍数 ×2')); }
  }
}
function renderHand() {
  const hand = byId('hand');
  if (!state.hand.length) {
    const empty = element('div', 'hand-empty');
    empty.append(element('span', '', '♠'), element('div', '', state.phase === 'finished' ? '这一手，打完了。' : '准备就绪，等待一手好牌。'));
    hand.replaceChildren(empty);
  } else { hand.replaceChildren(...state.hand.map(card => cardNode(card, false, true))); }
  updateSelection();
}
function updateSelection() {
  byId('selection-label').textContent = state.hand.length ? `手牌 ${state.hand.length} 张${selected.size ? ` · 已选 ${selected.size} 张` : ''}` : state.phase === 'finished' ? '对局结束' : '等待发牌';
  for (const node of byId('hand').querySelectorAll('button')) {
    node.classList.toggle('selected', selected.has(node.dataset.id));
    node.setAttribute('aria-pressed', String(selected.has(node.dataset.id)));
  }
  const button = byId('play-button');
  if (button) { button.disabled = busy || !connected || selected.size === 0; }
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
    bar.append(actionButton(player.ready ? '取消准备' : state.phase === 'finished' ? '准备下一局' : '准备', player.ready ? 'secondary' : 'primary', () => perform('ready', { ready: !player.ready })));
    if (state.host === state.you) {
      const allReady = state.players.every(entry => entry?.ready && entry.online);
      bar.append(actionButton('开始游戏', 'primary', () => perform('start'), !allReady));
    } else { bar.append(element('span', 'action-note', '准备后，等待房主开始')); }
    return;
  }
  if (state.turn !== state.you) {
    bar.append(element('span', 'action-note', `等待 ${state.players[state.turn].name} ${state.phase === 'bidding' ? '叫分' : '出牌'}…`));
    return;
  }
  if (state.phase === 'bidding') {
    bar.append(actionButton('不叫', 'secondary', () => perform('bid', { value: 0 })));
    for (const value of [1, 2, 3]) { bar.append(actionButton(`${value} 分`, value === 3 ? 'primary' : 'secondary', () => perform('bid', { value }), value <= state.bid)); }
    return;
  }
  bar.append(actionButton('不出', 'secondary', () => perform('pass'), !state.lastPlay));
  bar.append(actionButton('提示', 'hint', showHint));
  bar.append(actionButton('重选', 'secondary', async () => { selected.clear(); updateSelection(); }));
  bar.append(actionButton('出牌', 'primary', async () => {
    await perform('play', { ids: [...selected] });
    selected.clear(); updateSelection();
  }, selected.size === 0, 'play-button'));
  byId('hand-help').textContent = state.canBeat ? '点击牌面选择，再点击出牌' : '暂时没有能压过的牌，可以选择不出';
}
async function showHint() {
  const key = `${state.round}/${state.turn}/${state.hand.map(card => card.id).join(',')}/${state.lastPlay?.cards.map(card => card.id).join(',') || ''}`;
  if (key !== hintKey) {
    hintMoves = (await api('hint')).moves;
    hintKey = key; hintIndex = 0;
  }
  selected.clear();
  if (!hintMoves.length) { updateSelection(); toast('没有能压过的牌，选择「不出」吧。'); return; }
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
    byId('turn-status').textContent = state.phase === 'finished' ? '准备好，再来一局。' : '局域网牌桌 · 仅娱乐积分';
    return;
  }
  const seconds = Math.max(0, Math.ceil((state.deadline - Date.now() - serverOffset) / 1000));
  clock.textContent = `${String(seconds).padStart(2, '0')}s`;
  clock.classList.toggle('urgent', seconds <= 8);
  byId('turn-status').textContent = `${state.turn === state.you ? '轮到你' : state.players[state.turn].name}${state.phase === 'bidding' ? '叫分' : '出牌'}${state.phase === 'playing' && !state.lastPlay ? ' · 自由领出' : ''}`;
}
async function copyInvite() {
  const addressInfo = await fetch('/api/info').then(response => response.json());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const base = local ? addressInfo.addresses[0] || location.origin : location.origin;
  const invite = `${base}/?room=${state.code}`;
  const text = `来玩斗地主：${invite}\n房间号：${state.code}\n请连接同一局域网`;
  try {
    if (!navigator.clipboard?.writeText) { throw new Error('Clipboard unavailable'); }
    await navigator.clipboard.writeText(text);
    toast('邀请已复制，发给同一局域网的朋友吧。');
  } catch {
    const input = element('textarea', 'sr-only', text);
    document.body.append(input); input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (copied) { toast('邀请已复制，发给朋友吧。'); }
    else { toast(`请分享地址 ${base} 和房间号 ${state.code}`); }
  }
}

byId('nickname').value = storageGet(NAME_KEY) || '';
byId('create-tab').addEventListener('click', () => setEntryTab(false));
byId('join-tab').addEventListener('click', () => setEntryTab(true));
byId('create-button').addEventListener('click', () => { void withBusy(async () => enterRoom(await api('create', { name: readName() }))); });
byId('practice-button').addEventListener('click', () => { void withBusy(async () => enterRoom(await api('create', { name: readName(), practice: true }))); });
byId('join-button').addEventListener('click', () => {
  void withBusy(async () => {
    const name = readName();
    const code = byId('room-code').value.trim();
    if (!/^\d{6}$/.test(code)) { byId('room-code').focus(); throw new Error('请输入六位数字房间号。'); }
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
