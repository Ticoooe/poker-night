// Estado da aplicação + persistência no localStorage do aparelho.
import { activeBuys, computeSettlement, computeTotals } from './calc.js';

const KEY = 'poker-night:v1';

export const DEFAULT_SETTINGS = {
  groupName: 'Poker dos Amigos',
  buyValue: 5000, // centavos
  chipsPerBuy: 1000,
  rakeMode: 'none', // none | perBuy | percent | fixed
  rakeValue: 0, // centavos (perBuy / fixed) ou porcentagem (percent)
  paymentMode: 'acerto', // acerto (Pix no final) | caixa (buy pago na hora)
  requireSignature: true,
  requireConfirmAtClose: true,
  adminPin: '',
};

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const listeners = new Set();
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (err) {
    console.error('Falha ao carregar dados', err);
  }
  return normalize({});
}

function normalize(data) {
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    session: data.session ?? null,
    history: Array.isArray(data.history) ? data.history : [],
  };
}

function commit({ silent = false } = {}) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    alert('Não foi possível salvar no aparelho (armazenamento cheio?). Exporte um backup em Admin.');
    throw err;
  }
  if (!silent) listeners.forEach((fn) => fn(state));
}

// Mantém abas/janelas do mesmo aparelho sincronizadas.
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  state = load();
  listeners.forEach((fn) => fn(state));
});

export const getState = () => state;
export const subscribe = (fn) => listeners.add(fn);
export const storageSize = () => (localStorage.getItem(KEY) || '').length;

function requireSession() {
  if (!state.session) throw new Error('Nenhuma jogatina em andamento');
  return state.session;
}

function log(type, data) {
  const entry = { id: uid(), type, at: Date.now(), ...data };
  state.session.ledger.push(entry);
  return entry;
}

// ---------- Configurações ----------
export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  commit();
}

// ---------- Jogatina ----------
export function startSession(names = []) {
  if (state.session) throw new Error('Já existe uma jogatina em andamento');
  state.session = { id: uid(), startedAt: Date.now(), players: [], ledger: [], draft: { counts: {}, confirmed: {} } };
  names.forEach((n) => addPlayerRaw(n));
  commit();
}

function addPlayerRaw(rawName) {
  const session = requireSession();
  const name = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Informe o nome do jogador');
  if (session.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`"${name}" já está na mesa`);
  }
  const player = { id: uid(), name, joinedAt: Date.now() };
  session.players.push(player);
  log('player_add', { playerId: player.id, name });
  return player;
}

export function addPlayer(name) {
  const p = addPlayerRaw(name);
  commit();
  return p;
}

export function renamePlayer(playerId, newName) {
  const session = requireSession();
  const name = String(newName || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Informe o nome');
  if (session.players.some((p) => p.id !== playerId && p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`"${name}" já está na mesa`);
  }
  const p = getPlayer(playerId);
  log('player_rename', { playerId, from: p.name, to: name });
  p.name = name;
  commit();
}

export function removePlayer(playerId) {
  const session = requireSession();
  if (activeBuys(session.ledger, playerId).length) throw new Error('Anule os buys antes de remover o jogador');
  const p = getPlayer(playerId);
  session.players = session.players.filter((x) => x.id !== playerId);
  log('player_remove', { playerId, name: p.name });
  commit();
}

export const getPlayer = (playerId) => state.session?.players.find((p) => p.id === playerId);

export function addBuy(playerId, signature) {
  const session = requireSession();
  const { buyValue, chipsPerBuy, rakeMode, rakeValue, requireSignature } = state.settings;
  if (!getPlayer(playerId)) throw new Error('Jogador não encontrado');
  if (requireSignature && !signature) throw new Error('Assinatura obrigatória');
  const entry = log('buy', {
    playerId,
    seq: activeBuys(session.ledger, playerId).length + 1,
    value: buyValue,
    chips: chipsPerBuy,
    rake: rakeMode === 'perBuy' ? Math.min(rakeValue, buyValue) : 0,
    signature: signature || null,
  });
  commit();
  return entry;
}

/** Buys nunca são apagados: são anulados com motivo e ficam no registro. */
export function voidBuy(entryId, reason) {
  const session = requireSession();
  const entry = session.ledger.find((e) => e.id === entryId && e.type === 'buy');
  if (!entry || entry.voided) return;
  entry.voided = { at: Date.now(), reason: String(reason || '').trim() || 'Sem motivo' };
  log('void', { refId: entryId, playerId: entry.playerId, reason: entry.voided.reason });
  commit();
}

export function playerStats(playerId) {
  const buys = activeBuys(state.session?.ledger || [], playerId);
  return { buys: buys.length, paid: buys.reduce((a, b) => a + b.value, 0) };
}

export const totals = () => computeTotals(state.session?.ledger || [], state.settings);

// ---------- Fechamento ----------
export function saveDraft(draft) {
  requireSession().draft = draft;
  commit({ silent: true });
}

export const settlement = (counts) => computeSettlement(requireSession(), state.settings, counts);

export function closeSession(counts) {
  const session = requireSession();
  const result = settlement(counts);
  if (result.diff !== 0) throw new Error('A contagem de fichas não bate com o total em jogo');
  session.closedAt = Date.now();
  session.settingsAtClose = { ...state.settings, adminPin: undefined };
  session.result = result;
  delete session.draft;
  state.history.unshift(session);
  state.session = null;
  commit();
  return session.id;
}

export function cancelSession() {
  state.session = null;
  commit();
}

export const getHistorySession = (id) => state.history.find((s) => s.id === id);

export function deleteHistorySession(id) {
  state.history = state.history.filter((s) => s.id !== id);
  commit();
}

export function clearHistory() {
  state.history = [];
  commit();
}

/** Nomes que mais jogaram, para adicionar com um toque. */
export function frequentPlayers(limit = 12) {
  const freq = new Map();
  for (const s of state.history) {
    for (const p of s.players) freq.set(p.name, (freq.get(p.name) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => n);
}

// ---------- Backup ----------
export const exportData = () => JSON.stringify({ app: 'poker-night', version: 1, exportedAt: Date.now(), ...state }, null, 2);

export function importData(json) {
  const data = JSON.parse(json);
  if (data.app !== 'poker-night') throw new Error('Arquivo não é um backup do Poker Night');
  state = normalize(data);
  commit();
}
