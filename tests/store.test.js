// Testes do fluxo da mesa (store.js) em modo local: buys, aprovação, saída, fechamento,
// lixeira, acertos e junção de nomes. Simula o navegador com um localStorage em memória.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = { addEventListener() {} };
globalThis.alert = () => {};

let S;
before(async () => {
  S = await import('../js/store.js');
  S.updateSettings({ requireSignature: false, requireApproval: true });
});

const ids = () => S.getState().session.players.map((p) => p.id);

test('regras do grupo: R$ 30 = 55 fichas em jogo + R$ 2,50 de rake', () => {
  const t = S.buyTerms();
  assert.deepEqual([t.value, t.chips, t.rake], [3000, 55, 250]);
});

test('pedido de vários buys fica pendente e só entra no pote quando aprovado', async () => {
  await S.startSession(['Tico', 'Ian', 'Davi']);
  const [tico, ian] = ids();
  S.addBuys(tico, 3);
  assert.equal(S.totals().pot, 0);
  assert.equal(S.pendingRequests().length, 1);
  assert.equal(S.pendingRequests()[0].entries.length, 3);

  assert.equal(S.approveRequest(S.pendingRequests()[0].key), 3);
  assert.equal(S.totals().pot, 9000);
  assert.equal(S.totals().chips, 165);

  S.addBuys(ian, 2);
  assert.equal(S.rejectRequest(S.pendingRequests()[0].key, 'sem fichas'), 2);
  assert.equal(S.totals().pot, 9000);
  assert.equal(S.playerStats(ian).buys, 0);
});

test('não fecha com pedido pendente nem com contagem errada', async () => {
  const [tico, ian, davi] = ids();
  S.addBuys(ian, 1);
  await assert.rejects(S.closeSession(), /aguardando aprovação/);
  S.approveRequest(S.pendingRequests()[0].key);
  S.addBuys(davi, 1);
  S.approveRequest(S.pendingRequests()[0].key);
  // 5 buys = 275 fichas
  S.setCount(tico, 100);
  S.setCount(ian, 100);
  S.setCount(davi, 70);
  await assert.rejects(S.closeSession(), /não bate/);
});

test('saída individual trava a contagem e bloqueia novos buys', () => {
  const [, ian] = ids();
  S.cashOut(ian, 40);
  assert.throws(() => S.setCount(ian, 10), /travada/);
  assert.throws(() => S.addBuys(ian, 1), /já encerrou/);
  const r = S.previewCashOut(ian, 40);
  assert.equal(r.payout, 2000); // 40 fichas × R$ 0,50
  assert.equal(r.net, -1000);
});

test('fecha quando a conta bate e a soma dos saldos é exatamente o rake', async () => {
  const [tico, , davi] = ids();
  S.setCount(tico, 165);
  S.setCount(davi, 70); // 165 + 40 (Ian) + 70 = 275
  const sid = await S.closeSession();
  const s = S.getHistorySession(sid);
  const nets = s.result.rows.reduce((a, r) => a + r.net, 0);
  assert.equal(nets + s.result.totals.rake, 0);
  assert.equal(S.getState().session, null);
});

test('acertos: lista quem paga/recebe e marca como feito', () => {
  const s = S.getState().history[0];
  const items = S.settlementItems(s);
  assert.ok(items.some((x) => x.kind === 'pagar') && items.some((x) => x.kind === 'receber'));
  assert.equal(S.openSettlements().length, items.length);
  S.setSettled(s.id, items[0].playerId, true);
  assert.equal(S.openSettlements().length, items.length - 1);
  S.settleAll(s.id);
  assert.equal(S.openSettlements().length, 0);
});

test('apagar partida vai para a lixeira e dá para restaurar', () => {
  const id = S.getState().history[0].id;
  S.deleteHistorySession(id);
  assert.equal(S.getState().history.length, 0);
  assert.equal(S.getState().trash.length, 1);
  S.restoreHistorySession(id);
  assert.equal(S.getState().history.length, 1);
  S.deleteHistorySession(id);
  S.emptyTrash();
  assert.equal(S.getState().trash.length, 0);
});

test('nome digitado sem acento usa a grafia conhecida', async () => {
  await S.startSession(['tita', 'TICO']);
  assert.deepEqual(S.getState().session.players.map((p) => p.name), ['Titã', 'Tico']);
  await S.cancelSession();
});

test('juntar jogadores troca o nome no histórico e recusa quem jogou junto', async () => {
  S.updateSettings({ requireApproval: false, regulars: ['Tico', 'Felipin'] });
  await S.startSession(['Tico', 'Felipinho']);
  const [a, b] = ids();
  S.addBuys(a, 1);
  S.addBuys(b, 1);
  S.setCount(a, 55);
  S.setCount(b, 55);
  await S.closeSession();
  assert.throws(() => S.mergePlayers('Felipinho', 'Tico'), /mesma noite/);
  assert.equal(S.mergePlayers('Felipinho', 'Felipin'), 1);
  const names = S.getState().history[0].result.rows.map((r) => r.name).sort();
  assert.deepEqual(names, ['Felipin', 'Tico']);
});
