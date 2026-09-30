import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSettlement, computeTotals, distribute, computeTransfers } from '../js/calc.js';

const buy = (playerId, value = 5000, chips = 1000, extra = {}) => ({ type: 'buy', playerId, value, chips, rake: 0, ...extra });
const base = { rakeMode: 'none', rakeValue: 0 };

test('soma dos pagamentos é exatamente o prêmio (sem quebra de centavos)', () => {
  const r = distribute([{ id: 'a', chips: 1 }, { id: 'b', chips: 1 }, { id: 'c', chips: 1 }], 3, 10000);
  assert.equal(r.a + r.b + r.c, 10000);
});

test('buys anulados não entram no pote', () => {
  const t = computeTotals([buy('a'), buy('a', 5000, 1000, { voided: { reason: 'x' } })], base);
  assert.equal(t.pot, 5000);
  assert.equal(t.chips, 1000);
});

test('rake percentual, por buy e fixo', () => {
  const ledger = [buy('a'), buy('b'), buy('b')];
  assert.equal(computeTotals(ledger, { rakeMode: 'percent', rakeValue: 5 }).rake, 750);
  assert.equal(computeTotals([buy('a', 5000, 1000, { rake: 500 })], { rakeMode: 'perBuy', rakeValue: 500 }).rake, 500);
  assert.equal(computeTotals(ledger, { rakeMode: 'fixed', rakeValue: 99999999 }).rake, 15000);
});

test('fechamento fecha a conta: saldos + rake = 0 e transferências zeram tudo', () => {
  const session = {
    players: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bia' }, { id: 'c', name: 'Caio' }],
    ledger: [buy('a'), buy('b'), buy('b'), buy('c'), buy('c'), buy('c')],
  };
  const r = computeSettlement(session, { rakeMode: 'percent', rakeValue: 7 }, { a: 3333, b: 2000, c: 667 });
  assert.equal(r.diff, 0);
  const payouts = r.rows.reduce((s, x) => s + x.payout, 0);
  assert.equal(payouts, r.totals.prize);
  const nets = r.rows.reduce((s, x) => s + x.net, 0);
  assert.equal(nets + r.totals.rake, 0);

  const balance = Object.fromEntries([...r.rows.map((x) => [x.name, x.net]), ['Casa (rake)', r.totals.rake]]);
  for (const t of r.transfers) { balance[t.from] += t.amount; balance[t.to] -= t.amount; }
  assert.ok(Object.values(balance).every((v) => v === 0));
});

test('contagem divergente é detectada', () => {
  const session = { players: [{ id: 'a', name: 'Ana' }], ledger: [buy('a')] };
  assert.equal(computeSettlement(session, base, { a: 900 }).diff, -100);
});

test('transferências mínimas', () => {
  const t = computeTransfers([{ name: 'A', net: -100 }, { name: 'B', net: 60 }, { name: 'C', net: 40 }]);
  assert.deepEqual(t, [{ from: 'A', to: 'B', amount: 60 }, { from: 'A', to: 'C', amount: 40 }]);
});

test('regra do grupo: buy R$30 = 60 fichas, 5 de rake (R$2,50) → 55 em jogo', () => {
  const b = (id) => buy(id, 3000, 55, { rake: 250 });
  const session = {
    players: [{ id: 'a', name: 'Tico' }, { id: 'b', name: 'Ian' }, { id: 'c', name: 'Davi' }],
    ledger: [b('a'), b('b'), b('b'), b('c')],
  };
  const r = computeSettlement(session, { rakeMode: 'perBuy', rakeValue: 5 }, { a: 150, b: 0, c: 70 });
  assert.equal(r.totals.pot, 12000);
  assert.equal(r.totals.rake, 1000);
  assert.equal(r.totals.chips, 220);
  assert.equal(r.diff, 0);
  // 1 ficha = R$0,50
  assert.deepEqual(r.rows.map((x) => x.payout), [7500, 0, 3500]);
  assert.deepEqual(r.rows.map((x) => x.net), [4500, -6000, 500]);
});
