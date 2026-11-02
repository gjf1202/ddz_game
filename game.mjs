import { randomInt } from 'node:crypto';

export const PLAYER_COUNT = 3;
export const HAND_SIZE = 17;
const MAX_SEQUENCE_RANK = 14;
const SUITS = ['♠', '♥', '♣', '♦'];
const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: 'SJ', 17: 'BJ' };

export function makeDeck() {
  const cards = [];
  for (let rank = 3; rank <= 15; rank++) {
    for (let suit = 0; suit < SUITS.length; suit++) {
      cards.push({ id: `${rank}-${suit}`, rank, suit: SUITS[suit], label: RANK_LABELS[rank] || String(rank), red: suit % 2 === 1 });
    }
  }
  for (const rank of [16, 17]) {
    cards.push({ id: `${rank}-0`, rank, suit: '★', label: RANK_LABELS[rank], red: rank === 17 });
  }
  return cards;
}

export function sortCards(cards) {
  return [...cards].sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id));
}

export function shuffledDeck() {
  const cards = makeDeck();
  for (let index = cards.length - 1; index > 0; index--) {
    const swapIndex = randomInt(index + 1);
    [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
  }
  return cards;
}

function groupCards(cards) {
  const groups = new Map();
  for (const card of cards) {
    if (!groups.has(card.rank)) { groups.set(card.rank, []); }
    groups.get(card.rank).push(card);
  }
  return groups;
}

function consecutive(ranks) {
  return ranks.length > 0 && ranks.at(-1) <= MAX_SEQUENCE_RANK && ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] + 1);
}

function pattern(type, rank, length, name) { return { type, rank, length, name }; }

/** Returns every valid interpretation so ambiguous airplanes can follow the previous play. */
export function analyzeCards(cards) {
  if (cards.length === 0) { return []; }
  const groups = groupCards(cards);
  const ranks = [...groups.keys()].sort((left, right) => left - right);
  const counts = ranks.map(rank => groups.get(rank).length);
  const length = cards.length;
  const result = [];
  if (length === 2 && ranks[0] === 16 && ranks[1] === 17) { return [pattern('rocket', 17, 2, 'Rocket')]; }
  if (ranks.length === 1) {
    const types = { 1: ['single', 'Single'], 2: ['pair', 'Pair'], 3: ['triple', 'Triple'], 4: ['bomb', 'Bomb'] };
    const entry = types[length];
    return entry ? [pattern(entry[0], ranks[0], length, entry[1])] : [];
  }
  const tripleRank = ranks.find(rank => groups.get(rank).length === 3);
  if (length === 4 && tripleRank) { result.push(pattern('triple-single', tripleRank, length, 'Triple + 1')); }
  if (length === 5 && tripleRank && counts.includes(2)) { result.push(pattern('triple-pair', tripleRank, length, 'Triple + pair')); }
  const fourRank = ranks.find(rank => groups.get(rank).length === 4);
  if (length === 6 && fourRank) { result.push(pattern('four-single', fourRank, length, 'Four + 2')); }
  if (length === 8 && fourRank && counts.filter(count => count === 2).length === 2) {
    result.push(pattern('four-pair', fourRank, length, 'Four + pairs'));
  }
  if (length >= 5 && counts.every(count => count === 1) && consecutive(ranks)) {
    result.push(pattern('straight', ranks.at(-1), length, 'Run'));
  }
  if (length >= 6 && counts.every(count => count === 2) && consecutive(ranks)) {
    result.push(pattern('pair-straight', ranks.at(-1), length, 'Pairs'));
  }
  const tripleRanks = ranks.filter(rank => rank <= MAX_SEQUENCE_RANK && groups.get(rank).length === 3);
  for (let start = 0; start < tripleRanks.length; start++) {
    for (let end = start + 2; end <= tripleRanks.length; end++) {
      const main = tripleRanks.slice(start, end);
      if (!consecutive(main)) { continue; }
      const wings = ranks.filter(rank => !main.includes(rank));
      const tripleCount = main.length;
      if (length === tripleCount * 3) { result.push(pattern('airplane', main.at(-1), length, 'Plane')); }
      if (length === tripleCount * 4 && wings.every(rank => groups.get(rank).length <= 2)) {
        result.push(pattern('airplane-single', main.at(-1), length, 'Plane + singles'));
      }
      if (length === tripleCount * 5 && wings.length === tripleCount && wings.every(rank => groups.get(rank).length === 2)) {
        result.push(pattern('airplane-pair', main.at(-1), length, 'Plane + pairs'));
      }
    }
  }
  return result;
}

export function beats(next, previous) {
  if (!previous) { return true; }
  if (previous.type === 'rocket') { return false; }
  if (next.type === 'rocket') { return true; }
  if (next.type === 'bomb' && previous.type !== 'bomb') { return true; }
  return next.type === previous.type && next.length === previous.length && next.rank > previous.rank;
}

export function resolvePlay(cards, previous = null) {
  return analyzeCards(cards).find(candidate => beats(candidate, previous)) || null;
}

function chooseGroups(groups, count, size, maxPerRank = size) {
  const entries = [...groups.values()];
  const result = [];
  function visit(index, remaining, picked) {
    if (remaining === 0) { result.push(picked); return; }
    if (index === entries.length) { return; }
    const available = Math.min(entries[index].length, maxPerRank, remaining);
    for (let take = 0; take <= available; take += size) {
      visit(index + 1, remaining - take, [...picked, ...entries[index].slice(0, take)]);
    }
  }
  visit(0, count * size, []);
  return result;
}

/** Enumerates rank-distinct legal plays without enumerating every combination of suits. */
export function legalMoves(hand, previous = null) {
  const groups = groupCards(hand);
  const ranks = [...groups.keys()].sort((left, right) => left - right);
  const moves = new Map();
  function add(cards) {
    const resolved = resolvePlay(cards, previous);
    if (!resolved) { return; }
    const key = cards.map(card => card.id).sort().join(',');
    moves.set(key, { cards: sortCards(cards), pattern: resolved });
  }
  function attach(main, count, size, maxPerRank) {
    const mainRanks = new Set(main.map(card => card.rank));
    const remainder = new Map([...groups].filter(([rank]) => !mainRanks.has(rank)));
    for (const wings of chooseGroups(remainder, count, size, maxPerRank)) { add([...main, ...wings]); }
  }
  for (const rank of ranks) {
    const cards = groups.get(rank);
    for (let size = 1; size <= cards.length; size++) { add(cards.slice(0, size)); }
    if (cards.length >= 3) {
      attach(cards.slice(0, 3), 1, 1, 1);
      attach(cards.slice(0, 3), 1, 2, 2);
    }
    if (cards.length === 4) {
      attach(cards, 2, 1, 2);
      attach(cards, 2, 2, 2);
    }
  }
  if (groups.has(16) && groups.has(17)) { add([...groups.get(16), ...groups.get(17)]); }
  for (const size of [1, 2, 3]) {
    const minLength = size === 1 ? 5 : size === 2 ? 3 : 2;
    for (let start = 3; start <= MAX_SEQUENCE_RANK; start++) {
      const main = [];
      for (let rank = start; rank <= MAX_SEQUENCE_RANK && (groups.get(rank)?.length || 0) >= size; rank++) {
        main.push(...groups.get(rank).slice(0, size));
        const count = rank - start + 1;
        if (count < minLength) { continue; }
        add([...main]);
        if (size === 3 && count * 4 <= hand.length) { attach(main, count, 1, 2); }
        if (size === 3 && count * 5 <= hand.length) { attach(main, count, 2, 2); }
      }
    }
  }
  return [...moves.values()].sort((left, right) => {
    const cost = move => (move.pattern.type === 'rocket' ? 2000 : move.pattern.type === 'bomb' ? 1000 : 0) + move.pattern.rank - (previous ? 0 : move.cards.length * 20);
    return cost(left) - cost(right);
  });
}
