// Estado da aplicação. Os dados formam uma árvore:
//   settings · session{players{}, ledger{}, draft{}} · history{} · signatures{sessão{buy}}
// Toda alteração vira um conjunto de caminhos → valores ("updates"), aplicado localmente
// e, se houver grupo online, enviado ao Firebase. Assim dois celulares lançando buys
// ao mesmo tempo nunca sobrescrevem um ao outro.
import { activeBuys, computeSettlement, computeTotals, pendingBuys as pendingOf } from './calc.js';
import { connect } from './sync.js';
import { firebaseConfig as bundledConfig } from './firebase-config.js';

const LOCAL_KEY = 'poker-night:v2';
const LEGACY_KEY = 'poker-night:v1';
const GROUP_KEY = 'poker-night:group'; // { code, config }
const ADMIN_DEVICE_KEY = 'poker-night:admin-device'; // PIN salvo só no aparelho do admin
const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  groupName: 'Poker das Uvas 🍇',
  buyValue: 3000, // centavos
  chipsPerBuy: 60, // fichas que o buy representa (incluindo as do rake)
  rakeMode: 'perBuy', // none | perBuy (fichas por buy) | percent | fixed (centavos)
  rakeValue: 5,
  paymentMode: 'acerto', // acerto (Pix no final) | caixa (buy pago na hora)
  requireSignature: true,
  requireConfirmAtClose: true,
  requireApproval: true, // buy só vale depois que o admin aprova
  adminPin: '',
  caixaName: '',
  caixaPhone: '', // WhatsApp de quem cuida do caixa
  caixaPix: '', // chave Pix do caixa (quem paga manda para ela)
  pix: {}, // chave Pix por jogador (chave = pixKey(nome))
  regulars: ['Tico', 'Ian', 'Giovanni', 'Davi', 'Marlon', 'Titã', 'Maciel', 'Nikin', 'Jota', 'Kevin', 'Felipin'],
};

const OLD_DEFAULT_NAMES = ['Poker dos Amigos', 'Poker Night'];
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const clean = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const listeners = new Set();

// ---------- Conexão ----------
const group = readJSON(GROUP_KEY);
const cacheKey = group ? `poker-night:cache:${group.code}` : LOCAL_KEY;
// Fila de lançamentos ainda não confirmados pelo servidor. Fica salva no aparelho:
// se o celular recarregar sem internet, nada se perde e tudo é reenviado depois.
const outboxKey = group ? `poker-night:outbox:${group.code}` : null;
let outbox = group ? readJSON(outboxKey) || [] : [];
let tree = loadTree();
overlayOutbox();
let view = derive(tree);
let remote = null;
let sessionLoaded = false; // só reenvia a fila depois de saber qual jogatina está no servidor
let flushing = false;
let sync = { mode: group ? 'connecting' : 'local', code: group?.code ?? null, error: null, dropped: 0 };

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function loadTree() {
  const data = readJSON(cacheKey) || (!group && migrateLegacy()) || {};
  return { settings: data.settings ?? null, session: data.session ?? null, history: data.history ?? null, signatures: data.signatures ?? null };
}

/** Converte os dados da v1 (arrays) para a árvore da v2. */
function migrateLegacy() {
  const old = readJSON(LEGACY_KEY);
  if (!old) return null;
  const toMap = (arr) => Object.fromEntries((arr || []).map((x) => [x.id, x]));
  const signatures = {};
  const convert = (s) => {
    signatures[s.id] = {};
    for (const e of s.ledger || []) {
      if (e.signature) signatures[s.id][e.id] = e.signature;
      delete e.signature;
    }
    return { ...s, players: toMap(s.players), ledger: toMap(s.ledger) };
  };
  return clean({
    settings: old.settings,
    session: old.session ? convert(old.session) : null,
    history: toMap((old.history || []).map(convert)),
    signatures,
  });
}

function saveOutbox() {
  try {
    localStorage.setItem(outboxKey, JSON.stringify(outbox));
  } catch {
    /* sem espaço: a fila continua na memória */
  }
}

function touchesSession(updates) {
  return Object.keys(updates).some((k) => k === 'session' || k.startsWith('session/'));
}

/** Reaplica na tela o que ainda está na fila (o servidor ainda não tem). */
function overlayOutbox(onlyKey) {
  for (const item of outbox) {
    if (touchesSession(item.updates) && tree.session?.id !== item.sessionId) continue;
    for (const [path, value] of Object.entries(item.updates)) {
      if (!onlyKey || path === onlyKey || path.startsWith(`${onlyKey}/`)) setPath(tree, path, value);
    }
  }
}

async function flushOutbox() {
  if (!remote || !sessionLoaded || flushing) return;
  flushing = true;
  try {
    while (outbox.length) {
      const item = outbox[0];
      // Lançamento de uma jogatina que já foi encerrada/descartada em outro celular: não reenvia,
      // senão recriaria pedaços de uma mesa que não existe mais.
      if (touchesSession(item.updates) && tree.session?.id !== item.sessionId) {
        sync = { ...sync, dropped: sync.dropped + 1 };
      } else {
        try {
          await remote.update(item.updates);
        } catch (err) {
          sync = { ...sync, error: err.message, dropped: sync.dropped + 1 };
        }
      }
      outbox = outbox.filter((x) => x.id !== item.id);
      saveOutbox();
      notify();
    }
  } finally {
    flushing = false;
  }
}

function settingsOf(raw) {
  // Grupos que ainda usam o nome padrão antigo passam a usar o novo.
  if (raw && OLD_DEFAULT_NAMES.includes(raw.groupName)) raw = { ...raw, groupName: DEFAULT_SETTINGS.groupName };
  // Configurações antigas (v1) são substituídas pelas novas regras do grupo.
  if (!raw || (raw.version ?? 1) < SETTINGS_VERSION) return { ...DEFAULT_SETTINGS, groupName: raw?.groupName ?? DEFAULT_SETTINGS.groupName, adminPin: raw?.adminPin ?? '' };
  return { ...DEFAULT_SETTINGS, ...raw, regulars: raw.regulars ?? [], pix: raw.pix ?? {} };
}

function sessionOf(raw) {
  if (!raw) return null;
  const players = Object.values(raw.players || {}).sort((a, b) => a.joinedAt - b.joinedAt);
  const ledger = Object.values(raw.ledger || {}).map((e) => ({ ...e })).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  // Numeração dos buys válidos de cada jogador (anulados ficam sem número).
  const seq = {};
  for (const e of ledger) {
    if (e.type === 'buy') e.seq = e.voided || e.pending ? null : (seq[e.playerId] = (seq[e.playerId] || 0) + 1);
  }
  const draft = { counts: { ...(raw.draft?.counts || {}) }, confirmed: { ...(raw.draft?.confirmed || {}) } };
  return { ...raw, players, ledger, draft };
}

function derive(t) {
  const all = Object.values(t.history || {})
    .map((s) => {
      const x = sessionOf(s);
      x.result = { ...x.result, rows: x.result?.rows || [], transfers: x.result?.transfers || [] };
      x.settled = { ...(s.settled || {}) };
      return x;
    })
    .sort((a, b) => b.closedAt - a.closedAt);
  return {
    settings: settingsOf(t.settings),
    session: sessionOf(t.session),
    history: all.filter((x) => !x.deletedAt),
    trash: all.filter((x) => x.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt),
  };
}

function saveLocal() {
  try {
    // Online, as assinaturas ficam no servidor; não ocupam espaço no aparelho.
    const data = remote ? { ...tree, signatures: null } : tree;
    localStorage.setItem(cacheKey, JSON.stringify(data));
  } catch (err) {
    alert('Não foi possível salvar no aparelho (armazenamento cheio?). Exporte um backup em Admin.');
  }
}

function notify() {
  view = derive(tree);
  listeners.forEach((fn) => fn(view));
}

function setPath(obj, path, value) {
  const keys = path.split('/');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (cur[k] == null || typeof cur[k] !== 'object') {
      if (value === null) return;
      cur[k] = {};
    }
    cur = cur[k];
  }
  if (value === null) delete cur[last];
  else cur[last] = value;
}

function apply(updates) {
  const cleaned = Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, clean(v)]));
  const sessionId = tree.session?.id ?? null;
  for (const [path, value] of Object.entries(cleaned)) setPath(tree, path, value);
  if (group) {
    outbox.push({ id: uid(), at: Date.now(), sessionId, updates: cleaned });
    saveOutbox();
  }
  saveLocal();
  notify();
  flushOutbox();
}

/** Ações que mexem na mesa inteira só rodam online e depois que a fila foi enviada. */
async function requireServer() {
  if (!group) return false;
  if (!remote || sync.mode !== 'online') throw new Error('Sem conexão. Espere a internet voltar para fazer isso.');
  for (let waited = 0; outbox.length && waited < 8000; waited += 200) {
    flushOutbox();
    await new Promise((r) => setTimeout(r, 200));
  }
  if (outbox.length) throw new Error('Ainda há lançamentos sendo enviados. Espere um instante e tente de novo.');
  return true;
}

/** Resumo do que importa na mesa, para conferir se o servidor está igual à tela. */
function fingerprint(s) {
  if (!s) return '';
  const byId = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const ledger = Object.values(s.ledger || {}).map((e) => [e.id, e.voided ? 1 : 0, e.pending ? 1 : 0]).sort(byId);
  const players = Object.values(s.players || {}).map((p) => [p.id, p.cashout?.chips ?? null]).sort(byId);
  const counts = Object.entries(s.draft?.counts || {}).sort(byId);
  return JSON.stringify([s.id, ledger, players, counts]);
}

if (group) {
  const config = bundledConfig || group.config;
  connect(config, group.code, {
    onStatus: (mode) => {
      sync = { ...sync, mode, error: mode === 'online' ? null : sync.error };
      notify();
      if (mode === 'online') flushOutbox();
    },
    onData: (key, value) => {
      tree[key] = value;
      overlayOutbox(key);
      if (key === 'session') sessionLoaded = true;
      saveLocal();
      notify();
      flushOutbox();
    },
    onError: (err) => {
      sync = { ...sync, mode: 'error', error: err.message };
      notify();
    },
  })
    .then((r) => { remote = r; })
    .catch((err) => {
      sync = { ...sync, mode: 'error', error: err.message };
      notify();
    });
}

// Mantém abas do mesmo aparelho sincronizadas (modo local).
window.addEventListener('storage', (e) => {
  if (e.key !== cacheKey || remote) return;
  tree = loadTree();
  notify();
});

export const getState = () => view;
export const subscribe = (fn) => listeners.add(fn);
export const storageSize = () => (localStorage.getItem(cacheKey) || '').length;
export const syncInfo = () => ({ ...sync, pending: outbox.length, hasConfig: Boolean(bundledConfig || group?.config) });
export const clearDropped = () => { sync = { ...sync, dropped: 0 }; notify(); };

function requireSession() {
  if (!view.session) throw new Error('Nenhuma jogatina em andamento');
  return view.session;
}

const entry = (type, data) => ({ id: uid(), type, at: Date.now(), ...data });
const ledgerPath = (e) => ({ [`session/ledger/${e.id}`]: e });

// ---------- Configurações ----------
export function updateSettings(patch) {
  const updates = {};
  const current = view.settings;
  // Se ainda estava na versão antiga, grava a configuração inteira.
  if ((tree.settings?.version ?? 1) < SETTINGS_VERSION) updates.settings = { ...current, ...patch };
  else for (const [k, v] of Object.entries(patch)) updates[`settings/${k}`] = v;
  apply(updates);
}

// ---------- Chaves Pix ----------
/** Nome → chave segura para o Firebase (sem . # $ [ ] /). */
export const pixKey = (name) => encodeURIComponent(String(name).trim().toLowerCase()).replace(/\./g, '%2E');
export const pixOf = (name) => view.settings.pix?.[pixKey(name)] || '';

export function setPix(name, value) {
  const pix = { ...view.settings.pix };
  const v = String(value || '').trim();
  if (v) pix[pixKey(name)] = v;
  else delete pix[pixKey(name)];
  updateSettings({ pix });
}

/** Todos os nomes conhecidos: frequentes, mesa atual e histórico. */
export function knownPlayers() {
  const seen = new Set();
  const names = [...(view.settings.regulars || []), ...(view.session?.players || []).map((p) => p.name), ...view.history.flatMap((s) => s.players.map((p) => p.name))];
  return names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

/** Fichas que entram em jogo por buy (descontando as do rake). */
export function buyTerms(settings = view.settings) {
  const { buyValue, chipsPerBuy, rakeMode, rakeValue } = settings;
  const rakeChips = rakeMode === 'perBuy' ? Math.min(Math.max(0, Math.round(rakeValue)), chipsPerBuy - 1) : 0;
  return {
    value: buyValue,
    chips: chipsPerBuy - rakeChips,
    rakeChips,
    rake: Math.round((rakeChips * buyValue) / chipsPerBuy),
    chipValue: buyValue / chipsPerBuy,
  };
}

// ---------- Jogatina ----------
/** Chave sem acento e sem maiúscula: "Titã", "tita" e "TITA" viram a mesma pessoa. */
export const nameKey = (name) => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Usa a grafia já conhecida do jogador (frequentes, mesa ou histórico), se existir. */
export function canonicalName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  return knownPlayers().find((n) => nameKey(n) === nameKey(name)) || name;
}

function normName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Informe o nome do jogador');
  return name;
}

function newPlayer(rawName, players) {
  const name = canonicalName(normName(rawName));
  if (players.some((p) => nameKey(p.name) === nameKey(name))) throw new Error(`"${name}" já está na mesa`);
  return { id: uid(), name, joinedAt: Date.now() };
}

export async function startSession(names = []) {
  if (view.session) throw new Error('Já existe uma jogatina em andamento');
  const online = await requireServer();
  const players = [];
  const ledger = [];
  for (const n of names) {
    const p = newPlayer(n, players);
    p.joinedAt += players.length; // mantém a ordem
    players.push(p);
    ledger.push(entry('player_add', { playerId: p.id, name: p.name }));
  }
  const session = {
    id: uid(),
    startedAt: Date.now(),
    players: Object.fromEntries(players.map((p) => [p.id, p])),
    ledger: Object.fromEntries(ledger.map((e) => [e.id, e])),
  };
  if (online) {
    // Só começa se não houver jogatina no servidor: um celular desatualizado nunca apaga a mesa.
    const r = await remote.transaction('session', (cur) => (cur ? undefined : clean(session)));
    if (!r.committed || r.value?.id !== session.id) throw new Error('Já existe uma jogatina em andamento, aberta em outro celular.');
    tree.session = r.value;
    saveLocal();
    notify();
    return;
  }
  apply({ session });
}

export function addPlayer(name) {
  const session = requireSession();
  const p = newPlayer(name, session.players);
  apply({ [`session/players/${p.id}`]: p, ...ledgerPath(entry('player_add', { playerId: p.id, name: p.name })) });
  return p;
}

export function renamePlayer(playerId, newName) {
  const session = requireSession();
  const name = normName(newName);
  if (session.players.some((p) => p.id !== playerId && p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`"${name}" já está na mesa`);
  }
  const p = getPlayer(playerId);
  apply({ [`session/players/${playerId}/name`]: name, ...ledgerPath(entry('player_rename', { playerId, from: p.name, to: name })) });
}

export function removePlayer(playerId) {
  const session = requireSession();
  if (activeBuys(session.ledger, playerId).length) throw new Error('Anule os buys antes de remover o jogador');
  const p = getPlayer(playerId);
  apply({
    [`session/players/${playerId}`]: null,
    [`session/draft/counts/${playerId}`]: null,
    [`session/draft/confirmed/${playerId}`]: null,
    ...ledgerPath(entry('player_remove', { playerId, name: p.name })),
  });
}

export const getPlayer = (playerId) => view.session?.players.find((p) => p.id === playerId);

export const MAX_BUYS_PER_REQUEST = 10;

/**
 * Registra `count` buys de uma vez (um pedido). Cada buy tem a própria assinatura
 * (`signatures[i]`) e todos compartilham o mesmo `requestId`, para o admin aprovar juntos.
 */
export function addBuys(playerId, count = 1, signatures = []) {
  const session = requireSession();
  if (!getPlayer(playerId)) throw new Error('Jogador não encontrado');
  if (getPlayer(playerId).cashout) throw new Error(`${getPlayer(playerId).name} já encerrou o jogo`);
  const n = Math.max(1, Math.min(MAX_BUYS_PER_REQUEST, Math.round(count)));
  if (view.settings.requireSignature && (signatures.length < n || signatures.some((x) => !x))) {
    throw new Error('Assinatura obrigatória em cada buy');
  }
  const t = buyTerms();
  const pending = Boolean(view.settings.requireApproval);
  const requestId = uid();
  const now = Date.now();
  const first = activeBuys(session.ledger, playerId).length + 1;
  const updates = { [`session/draft/confirmed/${playerId}`]: null }; // buy novo invalida a conferência
  const entries = [];
  for (let i = 0; i < n; i += 1) {
    const sig = signatures[i] || null;
    const e = {
      id: uid(), type: 'buy', at: now + i, playerId, requestId,
      value: t.value, chips: t.chips, rake: t.rake, rakeChips: t.rakeChips, signed: Boolean(sig),
      ...(pending ? { pending: true } : {}),
    };
    updates[`session/ledger/${e.id}`] = e;
    if (sig) updates[`signatures/${session.id}/${e.id}`] = sig;
    entries.push({ ...e, seq: first + i });
  }
  apply(updates);
  return entries;
}

export const addBuy = (playerId, signature) => addBuys(playerId, 1, [signature])[0];

export const pendingBuys = () => pendingOf(view.session?.ledger || []);

/** Pedidos pendentes agrupados (vários buys do mesmo jogador feitos juntos). */
export function pendingRequests() {
  const map = new Map();
  for (const e of pendingBuys()) {
    const key = e.requestId || e.id;
    if (!map.has(key)) map.set(key, { key, playerId: e.playerId, at: e.at, entries: [] });
    map.get(key).entries.push(e);
  }
  return [...map.values()].sort((a, b) => a.at - b.at);
}

const pendingOfRequest = (key) => pendingBuys().filter((e) => (e.requestId || e.id) === key);

/** Admin certifica o pedido inteiro: só a partir daqui os buys entram no pote. */
export function approveRequest(key) {
  const list = pendingOfRequest(key);
  if (!list.length) return 0;
  const now = Date.now();
  const updates = {};
  for (const e of list) {
    updates[`session/ledger/${e.id}/pending`] = null;
    updates[`session/ledger/${e.id}/approvedAt`] = now;
    updates[`session/draft/confirmed/${e.playerId}`] = null;
  }
  Object.assign(updates, ledgerPath(entry('approve', { requestId: key, refIds: list.map((e) => e.id), playerId: list[0].playerId })));
  apply(updates);
  return list.length;
}

export function rejectRequest(key, reason) {
  const list = pendingOfRequest(key);
  if (!list.length) return 0;
  const why = `Recusado pelo admin${reason ? `: ${String(reason).trim()}` : ''}`;
  const now = Date.now();
  const updates = {};
  for (const e of list) {
    updates[`session/ledger/${e.id}/pending`] = null;
    updates[`session/ledger/${e.id}/voided`] = { at: now, reason: why };
  }
  Object.assign(updates, ledgerPath(entry('void', { requestId: key, refIds: list.map((e) => e.id), playerId: list[0].playerId, reason: why })));
  apply(updates);
  return list.length;
}

/** Desfaz um pedido inteiro logo após o registro. */
export function voidBuys(ids, reason) {
  const session = requireSession();
  const why = String(reason || '').trim() || 'Sem motivo';
  const list = session.ledger.filter((e) => ids.includes(e.id) && e.type === 'buy' && !e.voided);
  if (!list.length) return;
  const now = Date.now();
  const updates = {};
  for (const e of list) {
    updates[`session/ledger/${e.id}/voided`] = { at: now, reason: why };
    updates[`session/draft/confirmed/${e.playerId}`] = null;
  }
  Object.assign(updates, ledgerPath(entry('void', { refIds: list.map((e) => e.id), playerId: list[0].playerId, reason: why })));
  apply(updates);
}

// ---------- Aparelho do admin ----------
export const isAdminDevice = () => {
  const pin = view.settings.adminPin;
  return Boolean(pin) && localStorage.getItem(ADMIN_DEVICE_KEY) === pin;
};
export function setAdminDevice(on) {
  if (on) localStorage.setItem(ADMIN_DEVICE_KEY, view.settings.adminPin);
  else localStorage.removeItem(ADMIN_DEVICE_KEY);
  notify();
}

/** Buys nunca são apagados: são anulados com motivo e ficam no registro. */
export function voidBuy(entryId, reason) {
  const session = requireSession();
  const e = session.ledger.find((x) => x.id === entryId && x.type === 'buy');
  if (!e || e.voided) return;
  if (getPlayer(e.playerId)?.cashout) throw new Error('Esse jogador já encerrou o jogo. Desfaça a saída antes de anular buys dele.');
  const why = String(reason || '').trim() || 'Sem motivo';
  apply({
    [`session/ledger/${entryId}/voided`]: { at: Date.now(), reason: why },
    [`session/draft/confirmed/${e.playerId}`]: null,
    ...ledgerPath(entry('void', { refId: entryId, playerId: e.playerId, reason: why })),
  });
}

const sigCache = new Map();
export async function getSignature(sessionId, entryId) {
  const key = `${sessionId}/${entryId}`;
  if (sigCache.has(key)) return sigCache.get(key);
  let value = tree.signatures?.[sessionId]?.[entryId] ?? null;
  if (!value && remote) value = await remote.get(`signatures/${key}`);
  if (value) sigCache.set(key, value);
  return value;
}

export function playerStats(playerId) {
  const ledger = view.session?.ledger || [];
  const buys = activeBuys(ledger, playerId);
  return { buys: buys.length, paid: buys.reduce((a, b) => a + b.value, 0), pending: pendingOf(ledger, playerId).length };
}

export const totals = () => computeTotals(view.session?.ledger || [], view.settings);

// ---------- Saída de um jogador (encerrar o jogo só dele) ----------
/** Quanto o jogador receberia saindo agora com `chips` fichas. */
export function previewCashOut(playerId, chips) {
  const session = requireSession();
  const r = computeSettlement(session, view.settings, { [playerId]: chips });
  const row = r.rows.find((x) => x.playerId === playerId);
  // Com rake por buy (ou sem rake) o valor da ficha é fixo; com % ou valor fixo na noite,
  // o valor final só se confirma no fechamento.
  const exact = view.settings.rakeMode === 'perBuy' || view.settings.rakeMode === 'none';
  const otherOut = session.players.filter((p) => p.id !== playerId && p.cashout).reduce((a, p) => a + p.cashout.chips, 0);
  return { ...row, exact, maxChips: r.totals.chips - otherOut };
}

export function cashOut(playerId, chips) {
  requireSession();
  const p = getPlayer(playerId);
  if (!p) throw new Error('Jogador não encontrado');
  if (p.cashout) throw new Error(`${p.name} já encerrou o jogo`);
  if (pendingOf(view.session.ledger, playerId).length) throw new Error('Aprove ou recuse os buys pendentes dele antes');
  const n = Number(chips);
  if (!Number.isInteger(n) || n < 0) throw new Error('Informe a quantidade de fichas');
  const { maxChips } = previewCashOut(playerId, n);
  if (n > maxChips) throw new Error(`Não pode passar de ${maxChips} fichas (total ainda em jogo)`);
  const now = Date.now();
  apply({
    [`session/players/${playerId}/cashout`]: { chips: n, at: now },
    [`session/draft/counts/${playerId}`]: n,
    [`session/draft/confirmed/${playerId}`]: now,
    ...ledgerPath(entry('cashout', { playerId, chips: n })),
  });
}

/** Volta o jogador para a mesa (ex.: saída registrada por engano). */
export function undoCashOut(playerId) {
  requireSession();
  const p = getPlayer(playerId);
  if (!p?.cashout) return;
  apply({
    [`session/players/${playerId}/cashout`]: null,
    [`session/draft/counts/${playerId}`]: null,
    [`session/draft/confirmed/${playerId}`]: null,
    ...ledgerPath(entry('cashout_undo', { playerId, chips: p.cashout.chips })),
  });
}

// ---------- Fechamento ----------
const lockedOut = (playerId) => {
  if (getPlayer(playerId)?.cashout) throw new Error('Jogador já encerrou o jogo — a contagem dele está travada');
};

export function setCount(playerId, chips) {
  requireSession();
  lockedOut(playerId);
  apply({ [`session/draft/counts/${playerId}`]: chips, [`session/draft/confirmed/${playerId}`]: null });
}

export function setConfirmed(playerId, ok) {
  requireSession();
  lockedOut(playerId);
  apply({ [`session/draft/confirmed/${playerId}`]: ok ? Date.now() : null });
}

export const settlement = (counts) => computeSettlement(requireSession(), view.settings, counts);

export async function closeSession() {
  const session = requireSession();
  const online = await requireServer();
  if (pendingBuys().length) throw new Error('Há buys aguardando aprovação do admin');
  const result = settlement(session.draft.counts);
  if (result.diff !== 0) throw new Error('A contagem de fichas não bate com o total em jogo');
  for (const row of result.rows) {
    const out = getPlayer(row.playerId)?.cashout;
    if (out) row.leftAt = out.at;
  }
  const raw = tree.session;
  const closed = {
    id: session.id,
    startedAt: session.startedAt,
    closedAt: Date.now(),
    players: raw.players,
    ledger: raw.ledger,
    result,
    settingsAtClose: { ...view.settings, adminPin: null, regulars: null, pix: null },
  };
  if (online) {
    // Confere no servidor que a mesa é a mesma da tela (buys, aprovações, saídas e contagens).
    const fp = fingerprint(raw);
    const r = await remote.transaction('session', (cur) => {
      if (cur === null) return null;
      return cur.id === session.id && fingerprint(cur) === fp ? cur : undefined;
    });
    if (!r.committed || !r.value || fingerprint(r.value) !== fp) {
      throw new Error('A mesa mudou em outro celular (buy, aprovação ou contagem). Confira os números e encerre de novo.');
    }
    const data = clean({ [`history/${session.id}`]: closed, session: null });
    await remote.update(data);
    for (const [path, value] of Object.entries(data)) setPath(tree, path, value);
    saveLocal();
    notify();
    return session.id;
  }
  apply({ [`history/${session.id}`]: closed, session: null });
  return session.id;
}

export async function cancelSession() {
  const id = view.session?.id;
  if (!id) return;
  if (await requireServer()) {
    const r = await remote.transaction('session', (cur) => (cur === null ? null : cur.id === id ? null : undefined));
    if (!r.committed) throw new Error('A jogatina no servidor é outra. Recarregue o app e confira.');
    tree.session = null;
    saveLocal();
    notify();
    apply({ [`signatures/${id}`]: null });
    return;
  }
  apply({ session: null, [`signatures/${id}`]: null });
}

export const getHistorySession = (id) => view.history.find((s) => s.id === id);

/** Apagar manda para a lixeira: dá para restaurar até alguém esvaziar a lixeira. */
export function deleteHistorySession(id) {
  apply({ [`history/${id}/deletedAt`]: Date.now() });
}

export function restoreHistorySession(id) {
  apply({ [`history/${id}/deletedAt`]: null });
}

export function clearHistory() {
  const now = Date.now();
  apply(Object.fromEntries(view.history.map((s) => [`history/${s.id}/deletedAt`, now])));
}

/** Exclusão definitiva (só a partir da lixeira). */
export function purgeHistorySession(id) {
  apply({ [`history/${id}`]: null, [`signatures/${id}`]: null });
}

export function emptyTrash() {
  const updates = {};
  for (const s of view.trash) {
    updates[`history/${s.id}`] = null;
    updates[`signatures/${s.id}`] = null;
  }
  if (Object.keys(updates).length) apply(updates);
}

// ---------- Acerto depois do fechamento (quem já pagou / recebeu) ----------
/** Quem paga e quem recebe no acerto pelo caixa, por jogador. */
export function settlementItems(s) {
  const upfront = s.settingsAtClose?.paymentMode === 'caixa';
  const items = [];
  for (const r of s.result.rows) {
    if (!upfront && r.net < 0) items.push({ playerId: r.playerId, name: r.name, kind: 'pagar', amount: -r.net });
    const receive = upfront ? r.payout : r.net;
    if (receive > 0) items.push({ playerId: r.playerId, name: r.name, kind: 'receber', amount: receive });
  }
  return items.map((x) => ({ ...x, settledAt: s.settled?.[x.playerId] || null }));
}

export function setSettled(sessionId, playerId, done) {
  apply({ [`history/${sessionId}/settled/${playerId}`]: done ? Date.now() : null });
}

export function settleAll(sessionId) {
  const s = getHistorySession(sessionId);
  if (!s) return;
  const now = Date.now();
  const updates = {};
  for (const x of settlementItems(s)) if (!x.settledAt) updates[`history/${sessionId}/settled/${x.playerId}`] = now;
  if (Object.keys(updates).length) apply(updates);
}

/** Acertos de noites anteriores que ainda não foram marcados como feitos. */
export function openSettlements() {
  return view.history.flatMap((s) => settlementItems(s).filter((x) => !x.settledAt).map((x) => ({ ...x, sessionId: s.id, startedAt: s.startedAt })));
}

// ---------- Juntar jogadores com nomes diferentes ----------
export function mergePreview(from, to) {
  const a = nameKey(from);
  const b = nameKey(to);
  let sessions = 0;
  const conflicts = [];
  for (const s of [...view.history, ...view.trash]) {
    const names = s.players.map((p) => nameKey(p.name));
    if (names.includes(a)) sessions += 1;
    if (names.includes(a) && names.includes(b)) conflicts.push(s.startedAt);
  }
  const inSession = view.session?.players.some((p) => nameKey(p.name) === a) && view.session?.players.some((p) => nameKey(p.name) === b);
  return { sessions, conflicts, inSession: Boolean(inSession) };
}

/** Troca o nome `from` por `to` em todo o histórico, na mesa, nos frequentes e no Pix. */
export function mergePlayers(from, to) {
  const a = nameKey(from);
  const target = String(to).trim();
  if (!a || !target || a === nameKey(target)) throw new Error('Escolha dois nomes diferentes');
  const preview = mergePreview(from, target);
  if (preview.conflicts.length || preview.inSession) throw new Error(`${from} e ${target} jogaram na mesma noite. Não dá para juntar.`);
  const updates = {};
  for (const [id, s] of Object.entries(tree.history || {})) {
    for (const [pid, p] of Object.entries(s.players || {})) {
      if (nameKey(p.name) === a) updates[`history/${id}/players/${pid}/name`] = target;
    }
    (s.result?.rows || []).forEach((r, i) => {
      if (nameKey(r.name) === a) updates[`history/${id}/result/rows/${i}/name`] = target;
    });
    if ((s.result?.transfers || []).some((t) => nameKey(t.from) === a || nameKey(t.to) === a)) {
      updates[`history/${id}/result/transfers`] = s.result.transfers.map((t) => ({
        ...t,
        from: nameKey(t.from) === a ? target : t.from,
        to: nameKey(t.to) === a ? target : t.to,
      }));
    }
  }
  for (const [pid, p] of Object.entries(tree.session?.players || {})) {
    if (nameKey(p.name) === a) updates[`session/players/${pid}/name`] = target;
  }
  const seen = new Set();
  const regulars = (view.settings.regulars || [])
    .map((n) => (nameKey(n) === a ? target : n))
    .filter((n) => !seen.has(nameKey(n)) && seen.add(nameKey(n)));
  const pix = { ...view.settings.pix };
  const fromPix = pix[pixKey(from)];
  if (fromPix && !pix[pixKey(target)]) pix[pixKey(target)] = fromPix;
  delete pix[pixKey(from)];
  if ((tree.settings?.version ?? 1) >= SETTINGS_VERSION) {
    updates['settings/regulars'] = regulars;
    updates['settings/pix'] = pix;
  }
  apply(updates);
  return preview.sessions;
}

/** Frequentes (cadastrados no Admin) primeiro, depois quem mais jogou. */
export function frequentPlayers(limit = 20) {
  const freq = new Map();
  for (const s of view.history) for (const p of s.players) freq.set(p.name, (freq.get(p.name) || 0) + 1);
  const byFreq = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const seen = new Set();
  return [...(view.settings.regulars || []), ...byFreq]
    .filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
    .slice(0, limit);
}

// ---------- Grupo online ----------
function groupConfig(config) {
  const c = bundledConfig || config;
  if (!c?.databaseURL) throw new Error('Configuração do Firebase ausente ou sem "databaseURL"');
  return c;
}

const withTimeout = (promise, ms = 15000) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('sem resposta do Firebase — confira a databaseURL, as regras e a internet')), ms)),
  ]);

const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

/** Cria um grupo online a partir dos dados deste aparelho. */
export async function createGroup(config) {
  const cfg = groupConfig(config);
  const code = newCode();
  const r = await withTimeout(connect(cfg, code));
  await withTimeout(r.set(clean({ ...tree, settings: view.settings, createdAt: Date.now() })));
  localStorage.setItem(GROUP_KEY, JSON.stringify({ code, config: bundledConfig ? null : cfg }));
  return code;
}

export async function joinGroup(code, config) {
  const cfg = groupConfig(config);
  const clean_ = String(code || '').trim().toLowerCase();
  if (!/^[a-z0-9]{6,}$/.test(clean_)) throw new Error('Código de grupo inválido');
  const r = await withTimeout(connect(cfg, clean_));
  const exists = await withTimeout(r.get('settings'));
  if (!exists) throw new Error('Grupo não encontrado');
  localStorage.setItem(GROUP_KEY, JSON.stringify({ code: clean_, config: bundledConfig ? null : cfg }));
}

export function leaveGroup() {
  localStorage.removeItem(GROUP_KEY);
}

export function inviteLink() {
  if (!group) return null;
  const url = new URL(location.href.split('#')[0]);
  url.search = '';
  url.searchParams.set('g', group.code);
  if (!bundledConfig && group.config) url.searchParams.set('c', btoa(JSON.stringify(group.config)));
  return url.toString();
}

// ---------- Backup ----------
export const exportData = () =>
  JSON.stringify({ app: 'poker-night', version: 2, exportedAt: Date.now(), ...tree, settings: view.settings }, null, 2);

export async function importData(json) {
  await requireServer();
  const data = JSON.parse(json);
  if (data.app !== 'poker-night') throw new Error('Arquivo não é um backup do Poker das Uvas');
  if ((data.version ?? 1) < 2) {
    localStorage.setItem(LEGACY_KEY, json);
    const migrated = migrateLegacy();
    Object.assign(data, migrated);
  }
  apply({ settings: data.settings, session: data.session ?? null, history: data.history ?? null, signatures: data.signatures ?? null });
}
