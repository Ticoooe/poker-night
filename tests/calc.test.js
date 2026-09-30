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
