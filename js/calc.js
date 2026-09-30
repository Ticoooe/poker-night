// Cálculos puros (sem DOM / sem storage). Todos os valores monetários em CENTAVOS (inteiros),
// para que nunca exista erro de arredondamento nem "quebra" de valores.

export const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
export const sum = (arr, fn = (x) => x) => arr.reduce((acc, x) => acc + fn(x), 0);

/** Buys válidos (não anulados), opcionalmente de um jogador. */
export function activeBuys(ledger, playerId) {
  return ledger.filter(
    (e) => e.type === 'buy' && !e.voided && (playerId == null || e.playerId === playerId),
  );
}

export function computeRake(pot, perBuyRake, settings) {
  switch (settings.rakeMode) {
    case 'perBuy':
      return perBuyRake;
    case 'percent':
      return Math.round((pot * clamp(Number(settings.rakeValue) || 0, 0, 100)) / 100);
    case 'fixed':
      return clamp(Number(settings.rakeValue) || 0, 0, pot);
    default:
      return 0;
  }
}

export function computeTotals(ledger, settings) {
  const buys = activeBuys(ledger);
  const pot = sum(buys, (b) => b.value);
  const chips = sum(buys, (b) => b.chips);
  const perBuyRake = sum(buys, (b) => b.rake || 0);
  const rake = computeRake(pot, perBuyRake, settings);
  return { count: buys.length, pot, chips, rake, prize: pot - rake };
}

/**
 * Divide o prêmio proporcionalmente às fichas de cada um.
 * Usa o método do "maior resto": quando a soma das fichas bate com o total,
 * a soma dos pagamentos é EXATAMENTE igual ao prêmio (nenhum centavo some ou sobra).
 */
export function distribute(items, totalChips, prize) {
  if (totalChips <= 0) return Object.fromEntries(items.map((i) => [i.id, 0]));
  const parts = items.map((i) => {
    const n = i.chips * prize;
    return { id: i.id, value: Math.floor(n / totalChips), rem: n % totalChips };
  });
  if (sum(items, (i) => i.chips) === totalChips) {
    let left = prize - sum(parts, (p) => p.value);
    [...parts]
      .sort((a, b) => b.rem - a.rem)
      .forEach((p) => {
        if (left > 0) {
          p.value += 1;
          left -= 1;
        }
      });
  }
  return Object.fromEntries(parts.map((p) => [p.id, p.value]));
}

/** Menor conjunto (guloso) de transferências para zerar os saldos. net > 0 = recebe. */
export function computeTransfers(parts) {
  const creditors = parts.filter((p) => p.net > 0).map((p) => ({ ...p })).sort((a, b) => b.net - a.net);
  const debtors = parts
    .filter((p) => p.net < 0)
    .map((p) => ({ ...p, net: -p.net }))
    .sort((a, b) => b.net - a.net);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].net, creditors[j].net);
    if (amount > 0) out.push({ from: debtors[i].name, to: creditors[j].name, amount });
    debtors[i].net -= amount;
    creditors[j].net -= amount;
    if (debtors[i].net === 0) i += 1;
    if (creditors[j].net === 0) j += 1;
  }
  return out;
}

/** Fechamento completo da jogatina a partir da contagem de fichas. */
export function computeSettlement(session, settings, counts) {
  const totals = computeTotals(session.ledger, settings);
  const items = session.players.map((p) => ({ id: p.id, chips: counts[p.id] ?? 0 }));
  const counted = sum(items, (i) => i.chips);
  const payouts = distribute(items, totals.chips, totals.prize);
  const rows = session.players.map((p) => {
    const buys = activeBuys(session.ledger, p.id);
    const paid = sum(buys, (b) => b.value);
    const payout = payouts[p.id];
    return { playerId: p.id, name: p.name, buys: buys.length, paid, chips: counts[p.id] ?? 0, payout, net: payout - paid };
  });
  const parts = rows.map((r) => ({ name: r.name, net: r.net }));
  if (totals.rake > 0) parts.push({ name: 'Casa (rake)', net: totals.rake });
  return { totals, counted, diff: counted - totals.chips, rows, transfers: computeTransfers(parts) };
}
