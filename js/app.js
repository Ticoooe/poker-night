import * as S from './store.js';
import { SignaturePad } from './signature.js';
import { computeRanking, monthKey } from './calc.js';
import { APP_VERSION } from './version.js';

const app = document.getElementById('app');
const dlg = document.getElementById('modal');
const toastEl = document.getElementById('toast');
const syncEl = document.getElementById('sync');
const netbar = document.getElementById('netbar');

// ---------- Formatação ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const signed = (cents) => (cents > 0 ? '+' : cents < 0 ? '−' : '') + money(Math.abs(cents));
const num = (n) => Number(n).toLocaleString('pt-BR');
const hour = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const day = (ts) => new Date(ts).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const toCents = (v) => Math.round((parseFloat(String(v).replace(',', '.')) || 0) * 100);
const initial = (name) => name.trim().charAt(0).toUpperCase();
const netClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function rakeLabel(s) {
  switch (s.rakeMode) {
    case 'perBuy': {
      const t = S.buyTerms(s);
      return `Rake ${plural(t.rakeChips, 'ficha', 'fichas')} (${money(t.rake)}) por buy`;
    }
    case 'percent': return `Rake ${s.rakeValue}% do pote`;
    case 'fixed': return `Rake ${money(s.rakeValue)} fixo`;
    default: return 'Sem rake';
  }
}

// ---------- Modal / toast ----------
let pressStartedOnBackdrop = false;
dlg.addEventListener('pointerdown', (e) => { pressStartedOnBackdrop = e.target === dlg; });
dlg.addEventListener('click', (e) => {
  if ((e.target === dlg && pressStartedOnBackdrop) || e.target.closest('[data-close]')) closeModal();
});

function openModal(html, onMount) {
  if (dlg.open) dlg.close();
  dlg.innerHTML = `<div class="modal">${html}</div>`;
  dlg.showModal();
  onMount?.(dlg);
}
function closeModal() {
  if (dlg.open) dlg.close();
}

/** Modal que devolve uma Promise — usado para confirmações, PIN e textos. */
function ask({ title, body = '', input, confirmText = 'Confirmar', danger = false, validate }) {
  return new Promise((resolve) => {
    let done = false;
    // O evento "close" do <dialog> é assíncrono: ignora o de um modal anterior.
    const onClose = () => { if (!dlg.open) finish(input ? null : false); };
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.removeEventListener('close', onClose);
      resolve(v);
      closeModal();
    };
    openModal(
      `<header><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
       <form class="ask">
         ${body ? `<div class="hint">${body}</div>` : ''}
         ${input ? `<input class="field" name="v" autocomplete="off" ${input}>` : ''}
         <p class="error" hidden></p>
         <footer>
           <button type="button" class="btn ghost" data-close>Cancelar</button>
           <button class="btn ${danger ? 'danger' : 'primary'}">${esc(confirmText)}</button>
         </footer>
       </form>`,
      (root) => {
        const form = root.querySelector('form');
        const field = form.querySelector('[name=v]');
        field?.focus();
        dlg.addEventListener('close', onClose);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const value = field ? field.value.trim() : true;
          const err = await validate?.(value);
          if (err) {
            const p = form.querySelector('.error');
            p.textContent = err;
            p.hidden = false;
            return;
          }
          finish(value);
        });
      },
    );
  });
}

const confirmDialog = (title, body, opts = {}) => ask({ title, body, ...opts });

let adminUnlockedUntil = 0;
async function requireAdmin(motivo) {
  const pin = S.getState().settings.adminPin;
  if (!pin || S.isAdminDevice() || Date.now() < adminUnlockedUntil) return true;
  const ok = await ask({
    title: 'PIN do administrador',
    body: `Necessário para ${esc(motivo)}.`,
    input: 'type="password" inputmode="numeric" placeholder="PIN"',
    confirmText: 'Liberar',
    validate: (v) => (v === pin ? null : 'PIN incorreto'),
  });
  if (ok) adminUnlockedUntil = Date.now() + 10 * 60 * 1000;
  return Boolean(ok);
}

let toastTimer;
function toast(msg, { action, onAction, timeout = 4000, type = '' } = {}) {
  clearTimeout(toastTimer);
  toastEl.className = `show ${type}`;
  toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  toastEl.querySelector('button')?.addEventListener('click', () => {
    onAction?.();
    toastEl.className = '';
  });
  toastTimer = setTimeout(() => { toastEl.className = ''; }, timeout);
}

async function attemptAsync(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message, { type: 'error', timeout: 7000 });
    return undefined;
  }
}

function attempt(fn) {
  try {
    return fn();
  } catch (err) {
    toast(err.message, { type: 'error' });
    return undefined;
  }
}

/** Preenche <img data-sig> com as assinaturas (buscadas no servidor quando online). */
function loadSignatures(root, sessionId) {
  root.querySelectorAll('[data-sig]').forEach(async (img) => {
    try {
      const src = await S.getSignature(sessionId, img.dataset.sig);
      if (src) img.src = src;
      else img.replaceWith(Object.assign(document.createElement('em'), { className: 'muted small', textContent: 'sem assinatura' }));
    } catch {
      img.alt = 'Assinatura indisponível offline';
    }
  });
}

const sigImg = (e) => (e.signed === false ? '<em class="muted small">sem assinatura</em>' : `<img data-sig="${e.id}" alt="Assinatura" />`);

// ---------- Componentes ----------
function summaryBar() {
  const { settings } = S.getState();
  const t = S.totals();
  return `
    <section class="summary" aria-label="Resumo da mesa">
      <div class="stat main"><span>Pote total</span><strong>${money(t.pot)}</strong></div>
      <div class="stat"><span>Buy</span><strong>${money(settings.buyValue)}</strong></div>
      <div class="stat"><span>Buys</span><strong>${t.count}</strong></div>
      <div class="stat"><span>Fichas</span><strong>${num(t.chips)}</strong></div>
      <div class="stat"><span>Rake</span><strong>${money(t.rake)}</strong></div>
    </section>`;
}

function termsLine(settings) {
  const t = S.buyTerms(settings);
  const rake = t.rakeChips ? ` + ${t.rakeChips} de rake (${money(t.rake)})` : settings.rakeMode === 'perBuy' ? ' · Sem rake' : ` · ${rakeLabel(settings)}`;
  return `Buy <strong>${money(t.value)}</strong> → <strong>${num(t.chips)} fichas</strong>${rake} · ficha = ${money(Math.round(t.chipValue))}`;
}

function chipsPips(n) {
  const shown = Math.min(n, 8);
  return `<span class="pips" aria-hidden="true">${'<i></i>'.repeat(shown)}${n > 8 ? '<b>…</b>' : ''}</span>`;
}

function renderSync() {
  const s = S.syncInfo();
  const labels = { local: 'Só neste aparelho', connecting: 'Conectando…', online: 'Online', offline: 'Sem conexão', error: 'Erro de sincronização' };
  syncEl.className = `sync ${s.mode}`;
  syncEl.title = labels[s.mode] + (s.error ? ` — ${s.error}` : '');
  syncEl.setAttribute('aria-label', syncEl.title);
}

/** Buys pedidos que aguardam o admin (aparece na mesa e no Admin). */
function pendingSection() {
  const { session } = S.getState();
  const requests = S.pendingRequests();
  if (!session || !requests.length) return '';
  const admin = S.isAdminDevice();
  const nameOf = (id) => session.players.find((p) => p.id === id)?.name ?? '—';
  const total = requests.reduce((a, r) => a + r.entries.length, 0);
  return `
    <section class="card pending-card" aria-live="polite">
      <h2>⏳ Aguardando aprovação (${plural(requests.length, 'pedido', 'pedidos')}${total > requests.length ? ` · ${total} buys` : ''})</h2>
      <p class="muted small">${admin ? 'Confira as assinaturas e se as fichas foram entregues.' : 'O admin precisa aprovar. Os buys só entram no pote depois disso.'}</p>
      ${requests.length > 1 ? `<button class="btn primary block" data-action="approve-all">${admin ? '' : '🔒 '}Aprovar todos (${plural(total, 'buy', 'buys')})</button>` : ''}
      <ul class="entries approvals">
        ${requests.map((r) => {
          const n = r.entries.length;
          const value = r.entries.reduce((a, e) => a + e.value, 0);
          const chips = r.entries.reduce((a, e) => a + e.chips, 0);
          return `<li>
          <div><strong>${esc(nameOf(r.playerId))} · ${plural(n, 'buy', 'buys')}</strong><small>Pedido às ${hour(r.at)} · ${money(value)} · ${num(chips)} fichas</small></div>
          <div class="sig-grid">${r.entries.map((e) => sigImg(e)).join('')}</div>
          <div class="approve-actions">
            <button class="btn small danger" data-action="reject-request" data-id="${r.key}">Recusar${n > 1 ? ' tudo' : ''}</button>
            <button class="btn small primary" data-action="approve-request" data-id="${r.key}">${admin ? '' : '🔒 '}Aprovar${n > 1 ? ` ${n} buys` : ''}</button>
          </div>
        </li>`;
        }).join('')}
      </ul>
    </section>`;
}

/** Aviso de acertos de Pix de noites anteriores que ainda não foram marcados como feitos. */
function owedBanner() {
  const open = S.openSettlements();
  if (!open.length) return '';
  const shortDay = (ts) => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const shown = open.slice(0, 4).map((x) => `<li><strong>${esc(x.name)}</strong> ${x.kind === 'pagar' ? 'deve' : 'tem a receber'} ${money(x.amount)} <small>(${shortDay(x.startedAt)})</small></li>`).join('');
  return `
    <a class="card owed" href="#/resultado/${open[0].sessionId}">
      <h2>💸 Acertos pendentes (${open.length})</h2>
      <ul>${shown}${open.length > 4 ? `<li class="muted">+ ${open.length - 4}…</li>` : ''}</ul>
      <small class="muted">Já acertou? Toque aqui e marque no resultado da noite.</small>
    </a>`;
}

// ---------- Views ----------
let pendingNames = [];

function viewStart() {
  const { settings } = S.getState();
  const frequent = S.frequentPlayers().filter((n) => !pendingNames.includes(n));
  return `
    <section class="hero">
      <div class="hero-suits">♠ ♥ ♦ ♣</div>
      <h1>Nova jogatina</h1>
      <p class="muted">${termsLine(settings)}</p>
    </section>
    <section class="card">
      <h2>Quem vai jogar?</h2>
      <form class="inline-form" data-form="pending-add">
        <input class="field" name="name" placeholder="Nome do jogador" autocomplete="off" enterkeyhint="done" />
        <button class="btn">Adicionar</button>
      </form>
      ${frequent.length ? `<p class="label">Frequentes — toque para incluir</p>
        <div class="chips">${frequent.map((n) => `<button class="chip" data-action="pending-toggle" data-name="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}
      ${pendingNames.length ? `<p class="label">Na mesa (${pendingNames.length})</p>
        <div class="chips">${pendingNames.map((n) => `<button class="chip on" data-action="pending-toggle" data-name="${esc(n)}">${esc(n)} ✕</button>`).join('')}</div>` : '<p class="muted small">Adicione pelo menos 2 jogadores (dá para incluir mais durante o jogo).</p>'}
    </section>
    <button class="btn primary big block" data-action="start" ${pendingNames.length < 2 ? 'disabled' : ''}>Começar jogatina</button>
    ${owedBanner()}`;
}

function viewMesa() {
  const { session, settings } = S.getState();
  if (!session) return viewStart();
  const inTable = new Set(session.players.map((p) => p.name.toLowerCase()));
  const frequent = S.frequentPlayers().filter((n) => !inTable.has(n.toLowerCase()));
  const recent = [...session.ledger].filter((e) => ['buy', 'void', 'cashout'].includes(e.type)).reverse().slice(0, 6);
  const nameOf = (id) => session.players.find((p) => p.id === id)?.name ?? '—';

  return `
    ${summaryBar()}
    <p class="session-meta">Começou ${hour(session.startedAt)} · ${termsLine(settings)}</p>
    ${pendingSection()}
    <section class="players">
      ${session.players.filter((p) => !p.cashout).map((p) => {
        const st = S.playerStats(p.id);
        return `
        <article class="player">
          <button class="player-info" data-action="player" data-id="${p.id}" aria-label="Detalhes de ${esc(p.name)}">
            <span class="avatar">${esc(initial(p.name))}</span>
            <span class="pname"><strong>${esc(p.name)}</strong><small>${money(st.paid)}${st.pending ? ` <em class="wait">+${st.pending} aguardando</em>` : ''}</small></span>
          </button>
          <div class="buycount" title="Buys">${chipsPips(st.buys)}<strong>${st.buys}</strong><small>${st.buys === 1 ? 'buy' : 'buys'}</small></div>
          <button class="btn-buy" data-action="buy" data-id="${p.id}">+ Buy</button>
        </article>`;
      }).join('') || `<p class="muted">${session.players.length ? 'Todos já encerraram o jogo.' : 'Nenhum jogador ainda.'}</p>`}
    </section>
    ${outSection(session)}
    <section class="card">
      <form class="inline-form" data-form="player-add">
        <input class="field" name="name" placeholder="Adicionar jogador" autocomplete="off" enterkeyhint="done" />
        <button class="btn">Adicionar</button>
      </form>
      ${frequent.length ? `<div class="chips">${frequent.map((n) => `<button class="chip" data-action="player-quick" data-name="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}
    </section>
    <a class="btn primary big block" href="#/fechar">Finalizar jogatina</a>
    ${owedBanner()}
    ${recent.length ? `
    <section class="card">
      <h2>Últimos registros</h2>
      <ul class="log">${recent.map((e) => e.type === 'buy'
        ? `<li class="${e.voided ? 'voided' : ''}"><time>${hour(e.at)}</time> <span>${e.voided ? 'Buy' : e.pending ? '⏳ Pedido de buy' : `Buy #${e.seq}`} · <strong>${esc(nameOf(e.playerId))}</strong></span> <span>${money(e.value)}</span></li>`
        : e.type === 'cashout' ? `<li><time>${hour(e.at)}</time> <span>🏁 <strong>${esc(nameOf(e.playerId))}</strong> encerrou o jogo com ${num(e.chips)} fichas</span></li>`
        : `<li class="void"><time>${hour(e.at)}</time> <span>Anulado · <strong>${esc(nameOf(e.playerId))}</strong> — ${esc(e.reason)}</span></li>`).join('')}
      </ul>
    </section>` : ''}`;
}

/** Jogadores que já encerraram o jogo (contagem travada). */
function outSection(session) {
  const out = session.players.filter((p) => p.cashout);
  if (!out.length) return '';
  return `
    <section class="card out-card">
      <h2>🏁 Já saíram (${out.length})</h2>
      <ul class="transfers">${out.map((p) => {
        const r = S.previewCashOut(p.id, p.cashout.chips);
        return `<li><button class="link-row" data-action="player" data-id="${p.id}">
          <span><strong>${esc(p.name)}</strong><small class="muted">Saiu às ${hour(p.cashout.at)} · ${num(p.cashout.chips)} fichas · ${plural(r.buys, 'buy', 'buys')}</small></span>
          <span class="right"><strong class="${netClass(r.net)}">${signed(r.net)}</strong><small class="muted">recebe ${money(r.payout)}${r.exact ? '' : ' (estim.)'}</small></span>
        </button></li>`;
      }).join('')}</ul>
    </section>`;
}

function viewFechar() {
  const { session, settings } = S.getState();
  if (!session) return viewMesa();
  const { draft } = session;
  return `
    ${summaryBar()}
    <section class="card">
      <h2>Fechamento</h2>
      <ol class="steps">
        <li>Conte as fichas de cada jogador <strong>na frente dele</strong>.</li>
        <li>Digite a quantidade — quem saiu zerado recebe <strong>0</strong>.</li>
        <li>O jogador confere e marca <strong>“Conferido”</strong>.</li>
        <li>O total contado precisa bater com as fichas em jogo. Senão, não fecha.</li>
      </ol>
    </section>
    <section class="close-list">
      ${session.players.map((p) => {
        const st = S.playerStats(p.id);
        const c = draft.counts[p.id];
        const out = p.cashout;
        return `
        <article class="close-row ${out ? 'is-out' : ''}" data-row="${p.id}">
          <div class="close-name"><span class="avatar sm">${esc(initial(p.name))}</span>
            <span><strong>${esc(p.name)}</strong><small>${out ? `🏁 Saiu às ${hour(out.at)} · ` : ''}${plural(st.buys, 'buy', 'buys')} · pagou ${money(st.paid)}</small></span></div>
          <label class="count"><span>Fichas${out ? ' 🔒' : ''}</span>
            <input class="field" data-count="${p.id}" inputmode="numeric" pattern="[0-9]*" placeholder="—" value="${c ?? ''}" ${out ? 'readonly' : ''} />
          </label>
          <div class="close-result"><small>Recebe</small><strong data-payout>—</strong><small data-net></small></div>
          ${settings.requireConfirmAtClose ? `<label class="confirm"><input type="checkbox" data-confirm="${p.id}" ${draft.confirmed[p.id] ? 'checked' : ''} ${out ? 'disabled' : ''}/> Conferido</label>` : ''}
        </article>`;
      }).join('')}
    </section>
    <div class="close-bar">
      <div class="progress"><div data-progress></div></div>
      <p data-status class="status"></p>
      <div class="row">
        <a class="btn ghost" href="#/">Voltar à mesa</a>
        <button class="btn primary" data-action="close-session" disabled>Encerrar e salvar</button>
      </div>
    </div>`;
}

/** Atualiza a tela de fechamento sem recriar os campos (não perde o foco ao digitar). */
function updateFechar() {
  const { session, settings } = S.getState();
  if (!session) return;
  const { draft } = session;
  const r = S.settlement(draft.counts);
  const expected = r.totals.chips;

  for (const row of r.rows) {
    const el = app.querySelector(`[data-row="${row.playerId}"]`);
    if (!el) continue;
    const has = draft.counts[row.playerId] != null;
    const input = el.querySelector('[data-count]');
    if (input !== document.activeElement) input.value = draft.counts[row.playerId] ?? '';
    const cb = el.querySelector('[data-confirm]');
    if (cb) cb.checked = Boolean(draft.confirmed[row.playerId]);
    el.querySelector('[data-payout]').textContent = has ? money(row.payout) : '—';
    const netEl = el.querySelector('[data-net]');
    netEl.textContent = has ? signed(row.net) : '';
    netEl.className = has ? netClass(row.net) : '';
    el.classList.toggle('done', has && (!settings.requireConfirmAtClose || Boolean(draft.confirmed[row.playerId])));
  }

  const missing = session.players.filter((p) => draft.counts[p.id] == null).length;
  const waiting = S.pendingBuys().length;
  const unconfirmed = settings.requireConfirmAtClose ? session.players.filter((p) => !draft.confirmed[p.id]).length : 0;
  const pct = expected ? Math.min(100, (r.counted / expected) * 100) : 0;
  const bar = app.querySelector('[data-progress]');
  bar.style.width = `${pct}%`;
  bar.className = r.diff > 0 ? 'over' : r.diff === 0 && expected ? 'ok' : '';

  let status;
  if (!session.players.length) status = 'Nenhum jogador na mesa.';
  else if (waiting) status = `⏳ ${plural(waiting, 'buy aguardando', 'buys aguardando')} aprovação do admin. Aprove ou recuse na mesa antes de fechar.`;
  else if (missing) status = `Contadas <strong>${num(r.counted)}</strong> de <strong>${num(expected)}</strong> fichas · falta contar ${plural(missing, 'jogador', 'jogadores')}.`;
  else if (r.diff < 0) status = `⚠️ Faltam <strong>${num(-r.diff)}</strong> fichas (${num(r.counted)} de ${num(expected)}). Reconte antes de fechar.`;
  else if (r.diff > 0) status = `⚠️ Sobram <strong>${num(r.diff)}</strong> fichas (${num(r.counted)} de ${num(expected)}). Tem ficha a mais na mesa ou buy sem registro.`;
  else if (unconfirmed) status = `✅ Contagem bate! Falta ${plural(unconfirmed, 'jogador', 'jogadores')} marcar “Conferido”.`;
  else status = `✅ Tudo certo: ${num(expected)} fichas conferidas. Prêmio de ${money(r.totals.prize)}.`;
  app.querySelector('[data-status]').innerHTML = status;

  app.querySelector('[data-action="close-session"]').disabled = !(session.players.length && !waiting && !missing && r.diff === 0 && !unconfirmed);
}

/** Quem paga e quem recebe no acerto pelo caixa. */
function caixaLists(s) {
  const r = s.result;
  const upfront = s.settingsAtClose?.paymentMode === 'caixa';
  const pagar = upfront ? [] : r.rows.filter((x) => x.net < 0).map((x) => ({ name: x.name, amount: -x.net })).sort((a, b) => b.amount - a.amount);
  const receber = r.rows.filter((x) => (upfront ? x.payout : x.net) > 0).map((x) => ({ name: x.name, amount: upfront ? x.payout : x.net })).sort((a, b) => b.amount - a.amount);
  return { pagar, receber, rake: r.totals.rake };
}

/** Chave Pix do caixa: a cadastrada no Admin ou, se não houver, a do jogador com o nome do caixa. */
const caixaPix = () => {
  const { settings } = S.getState();
  return settings.caixaPix || (settings.caixaName ? S.pixOf(settings.caixaName) : '');
};

function caixaMessage(s) {
  const { pagar, receber, rake } = caixaLists(s);
  const cfg = s.settingsAtClose || {};
  return [
    `♠ ${cfg.groupName || 'Poker'} — ${new Date(s.startedAt).toLocaleDateString('pt-BR')}`,
    '',
    '*A pagar:*',
    ...(pagar.length ? pagar.map((x) => `${x.name} - ${money(x.amount)} - Pix do caixa: ${caixaPix() || 'não cadastrado'}`) : ['Ninguém']),
    '',
    '*A receber:*',
    ...(receber.length ? receber.map((x) => `${x.name} - ${money(x.amount)} - Pix: ${S.pixOf(x.name) || 'não cadastrado'}`) : ['Ninguém']),
    ...(rake ? ['', `Rake (fica no caixa): ${money(rake)}`] : []),
  ].join('\n');
}

function whatsappLink(phone, text) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length <= 11) digits = `55${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function settleBtn(sessionId, x) {
  const label = x.kind === 'pagar' ? 'Pago' : 'Recebido';
  return `<button class="settle ${x.settledAt ? 'on' : ''}" data-action="settle" data-id="${sessionId}" data-player="${x.playerId}" aria-pressed="${Boolean(x.settledAt)}">${x.settledAt ? `✓ ${label}` : `Marcar ${label.toLowerCase()}`}</button>`;
}

function viewResultado(id) {
  const s = S.getHistorySession(id);
  if (!s) return `<section class="card"><p>Jogatina não encontrada.</p><a class="btn" href="#/historico">Voltar</a></section>`;
  const r = s.result;
  const cfg = s.settingsAtClose || {};
  const rows = [...r.rows].sort((a, b) => b.net - a.net);
  const caixa = cfg.paymentMode === 'caixa';
  const { settings } = S.getState();
  const lists = caixaLists(s);
  const items = S.settlementItems(s);
  const openCount = items.filter((x) => !x.settledAt).length;
  const wa = whatsappLink(settings.caixaPhone, caixaMessage(s));
  return `
    <section class="hero small">
      <p class="muted">${day(s.startedAt)} · ${hour(s.startedAt)}–${hour(s.closedAt)}</p>
      <h1>Resultado</h1>
    </section>
    <section class="summary three">
      <div class="stat main"><span>Pote total</span><strong>${money(r.totals.pot)}</strong></div>
      <div class="stat"><span>Buys</span><strong>${r.totals.count}</strong></div>
      <div class="stat"><span>Rake</span><strong>${money(r.totals.rake)}</strong></div>
      <div class="stat"><span>Prêmio</span><strong>${money(r.totals.prize)}</strong></div>
    </section>
    <section class="card">
      <h2>Jogadores</h2>
      <div class="table-wrap"><table class="results">
        <thead><tr><th>Jogador</th><th>Buys</th><th class="hide-xs">Pagou</th><th class="hide-xs">Fichas</th><th>Recebe</th><th>Saldo</th></tr></thead>
        <tbody>${rows.map((x) => `<tr><td><strong>${esc(x.name)}</strong>${x.leftAt ? `<small class="sub">saiu ${hour(x.leftAt)}</small>` : ''}</td><td>${x.buys}</td><td class="hide-xs">${money(x.paid)}</td><td class="hide-xs">${num(x.chips)}</td><td>${money(x.payout)}</td><td class="${netClass(x.net)}"><strong>${signed(x.net)}</strong></td></tr>`).join('')}</tbody>
      </table></div>
    </section>
    <section class="card caixa">
      <h2>Acerto com o caixa${settings.caixaName ? ` · ${esc(settings.caixaName)}` : ''}</h2>
      ${items.length ? `<p class="settle-status ${openCount ? '' : 'done'}">${openCount ? `${items.length - openCount} de ${items.length} acertos feitos` : '✅ Todos os acertos feitos'}</p>` : ''}
      <h3>A pagar</h3>
      <ul class="transfers">${items.filter((x) => x.kind === 'pagar').map((x) => `<li class="${x.settledAt ? 'is-settled' : ''}"><span><strong>${esc(x.name)}</strong><small class="pix ${caixaPix() ? '' : 'missing'}">Pix do caixa: ${esc(caixaPix() || 'não cadastrado')}</small></span>
        <span class="right"><strong class="neg">${money(x.amount)}</strong>${settleBtn(s.id, x)}</span></li>`).join('') || '<li class="muted">Ninguém</li>'}</ul>
      <h3>A receber</h3>
      <ul class="transfers">${items.filter((x) => x.kind === 'receber').map((x) => `<li class="${x.settledAt ? 'is-settled' : ''}"><span><strong>${esc(x.name)}</strong><small class="pix ${S.pixOf(x.name) ? '' : 'missing'}">Pix: ${esc(S.pixOf(x.name) || 'não cadastrado')}</small></span>
        <span class="right"><strong class="pos">${money(x.amount)}</strong>${settleBtn(s.id, x)}</span></li>`).join('') || '<li class="muted">Ninguém</li>'}</ul>
      ${lists.rake ? `<p class="muted small">Rake (fica no caixa): <strong>${money(lists.rake)}</strong></p>` : ''}
      ${lists.pagar.length && !caixaPix() ? '<p class="notice">Falta a chave Pix do caixa. Cadastre em Admin → Caixa (a mensagem usa a chave atual).</p>' : ''}
      ${lists.receber.some((x) => !S.pixOf(x.name)) ? '<p class="notice">Tem jogador para receber sem chave Pix. Cadastre em Admin → Chaves Pix (a mensagem usa a chave atual).</p>' : ''}
      <div class="row wrap">
        ${wa ? `<a class="btn primary whatsapp" href="${esc(wa)}" target="_blank" rel="noopener">Enviar para o caixa (WhatsApp)</a>`
             : '<button class="btn primary whatsapp" data-action="caixa-phone">Enviar para o caixa (WhatsApp)</button>'}
        <button class="btn" data-action="copy-caixa" data-id="${s.id}">Copiar mensagem</button>
      </div>
      ${openCount > 1 ? `<button class="btn ghost block" data-action="settle-all" data-id="${s.id}">Marcar todos como acertados</button>` : ''}
    </section>
    ${caixa ? '' : `
    <details class="card">
      <summary><h2>Alternativa: Pix direto entre jogadores</h2></summary>
      <ul class="transfers">${r.transfers.map((t) => `<li><span><strong>${esc(t.from)}</strong> → <strong>${esc(t.to)}</strong></span><strong>${money(t.amount)}</strong></li>`).join('') || '<li>Ninguém deve nada 🎉</li>'}</ul>
    </details>`}
    <div class="row wrap">
      <button class="btn" data-action="share" data-id="${s.id}">Compartilhar resumo</button>
      <button class="btn" data-action="audit" data-id="${s.id}">Ver assinaturas</button>
    </div>
    <div class="row wrap">
      <a class="btn ghost" href="#/historico">Histórico</a>
      <button class="btn danger" data-action="delete-session" data-id="${s.id}">Mandar para a lixeira</button>
    </div>`;
}

function shareText(s) {
  const r = s.result;
  const cfg = s.settingsAtClose || {};
  const rows = [...r.rows].sort((a, b) => b.net - a.net);
  const lines = [
    `♠ ${cfg.groupName || 'Poker'} — ${new Date(s.startedAt).toLocaleDateString('pt-BR')}`,
    `Pote: ${money(r.totals.pot)} · ${r.totals.count} buys · Rake: ${money(r.totals.rake)}`,
    '',
    '*Resultado*',
    ...rows.map((x) => `${signed(x.net)}  ${x.name} (${plural(x.buys, 'buy', 'buys')})`),
  ];
  if (cfg.paymentMode === 'caixa') {
    lines.push('', '*Caixa paga*', ...rows.filter((x) => x.payout > 0).map((x) => `${x.name}: ${money(x.payout)}`));
  } else if (r.transfers.length) {
    lines.push('', '*Pix*', ...r.transfers.map((t) => `${t.from} → ${t.to}: ${money(t.amount)}`));
  }
  return lines.join('\n');
}

const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
};
const monthShort = (key) => {
  const [y, m] = key.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${y}`;
};
const amount = (cents) => (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}º`;

/** Partidas agrupadas por mês (mais recente primeiro). */
function byMonth(history) {
  const groups = new Map();
  for (const s of history) {
    const k = monthKey(s.startedAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function historyTabs(active) {
  return `<nav class="tabs" aria-label="Histórico">
    <a href="#/historico" class="${active === 'partidas' ? 'active' : ''}">Partidas</a>
    <a href="#/ranking/geral" class="${active === 'ranking' ? 'active' : ''}">Ranking</a>
  </nav>`;
}

function trashSection() {
  const { trash } = S.getState();
  if (!trash.length) return '';
  return `
    <details class="card trash-card">
      <summary><h2>🗑 Lixeira (${trash.length})</h2></summary>
      <p class="muted small">Partidas apagadas ficam aqui até alguém esvaziar a lixeira. Restaurar devolve a partida ao histórico e ao ranking.</p>
      <ul class="transfers">${trash.map((x) => `<li><span><strong>${day(x.startedAt)}</strong><small class="muted">Pote ${money(x.result.totals.pot)} · apagada em ${new Date(x.deletedAt).toLocaleDateString('pt-BR')}</small></span>
        <span class="trash-actions"><button class="btn small" data-action="restore-session" data-id="${x.id}">Restaurar</button>
        <button class="btn small danger" data-action="purge-session" data-id="${x.id}">Excluir de vez</button></span></li>`).join('')}</ul>
      <button class="btn danger block" data-action="empty-trash">Esvaziar lixeira</button>
    </details>`;
}

function viewHistorico() {
  const { history } = S.getState();
  if (!history.length) return `<section class="hero"><h1>Histórico</h1><p class="muted">Nenhuma jogatina encerrada ainda.</p></section>${trashSection()}`;
  const current = monthKey(Date.now());
  const owedBySession = new Map();
  for (const x of S.openSettlements()) owedBySession.set(x.sessionId, (owedBySession.get(x.sessionId) || 0) + 1);
  return `
    <section class="hero small"><h1>Histórico</h1><p class="muted">${plural(history.length, 'jogatina', 'jogatinas')}</p></section>
    ${historyTabs('partidas')}
    ${owedBanner()}
    ${byMonth(history).map(([key, sessions]) => {
      const champ = computeRanking(sessions)[0];
      const pot = sessions.reduce((a, x) => a + x.result.totals.pot, 0);
      return `
      <section class="month">
        <a class="month-head" href="#/ranking/${key}">
          <span><strong>${monthLabel(key)}</strong><small>${plural(sessions.length, 'partida', 'partidas')} · ${money(pot)} em jogo${key === current ? ' · em andamento' : ''}</small></span>
          <span class="right">${champ && champ.net > 0 ? `<small>${key === current ? 'Liderando' : 'Campeão do mês'}</small><strong>🏆 ${esc(champ.name)} ${signed(champ.net)}</strong>` : ''}<small class="link-like">Ranking do mês →</small></span>
        </a>
        <div class="history">
          ${sessions.map((x) => {
            const best = [...x.result.rows].sort((a, b) => b.net - a.net)[0];
            return `<div class="history-row"><a class="history-item" href="#/resultado/${x.id}">
              <span><strong>${day(x.startedAt)}</strong><small>${plural(x.players.length, 'jogador', 'jogadores')} · ${plural(x.result.totals.count, 'buy', 'buys')}</small>${owedBySession.get(x.id) ? `<small class="owed-tag">💸 ${plural(owedBySession.get(x.id), 'acerto pendente', 'acertos pendentes')}</small>` : ''}</span>
              <span class="right"><strong>${money(x.result.totals.pot)}</strong>${best && best.net > 0 ? `<small>🏆 ${esc(best.name)} ${signed(best.net)}</small>` : ''}</span>
            </a><button class="icon-btn trash" data-action="delete-session" data-id="${x.id}" aria-label="Mandar partida de ${day(x.startedAt)} para a lixeira" title="Mandar para a lixeira">🗑</button></div>`;
          }).join('')}
        </div>
      </section>`;
    }).join('')}
    ${trashSection()}`;
}

function rankingData(period) {
  const { history } = S.getState();
  const sessions = period === 'geral' ? history : history.filter((x) => monthKey(x.startedAt) === period);
  return { sessions, rows: computeRanking(sessions) };
}

function viewRanking(period = 'geral') {
  const { history } = S.getState();
  if (!history.length) return `<section class="hero"><h1>Ranking</h1><p class="muted">O ranking aparece depois da primeira jogatina encerrada.</p></section>`;
  const months = byMonth(history).map(([k]) => k);
  if (period !== 'geral' && !months.includes(period)) period = 'geral';
  const { sessions, rows } = rankingData(period);
  const current = monthKey(Date.now());
  const pot = sessions.reduce((a, x) => a + x.result.totals.pot, 0);
  const rake = sessions.reduce((a, x) => a + x.result.totals.rake, 0);
  const title = period === 'geral' ? 'Ranking geral' : monthLabel(period);
  const status = period === 'geral' ? `desde ${day(sessions[sessions.length - 1].startedAt)}` : period === current ? 'mês em andamento' : 'mês encerrado';
  return `
    <section class="hero small"><h1>Histórico</h1></section>
    ${historyTabs('ranking')}
    <div class="chips periods">
      <a class="chip ${period === 'geral' ? 'on' : ''}" href="#/ranking/geral">Geral</a>
      ${months.map((k) => `<a class="chip ${period === k ? 'on' : ''}" href="#/ranking/${k}">${monthShort(k)}</a>`).join('')}
    </div>
    <section class="summary three">
      <div class="stat main"><span>${esc(title)}</span><strong>${plural(sessions.length, 'partida', 'partidas')}</strong></div>
      <div class="stat"><span>Em jogo</span><strong>${money(pot)}</strong></div>
      <div class="stat"><span>Rake</span><strong>${money(rake)}</strong></div>
      <div class="stat"><span>Jogadores</span><strong>${rows.length}</strong></div>
    </section>
    <p class="session-meta">${esc(status)}${period !== 'geral' && period !== current && rows[0]?.net > 0 ? ` · 🏆 Campeão: <strong>${esc(rows[0].name)}</strong>` : ''}</p>
    <section class="card">
      <div class="table-wrap"><table class="results ranking">
        <thead><tr><th>#</th><th>Jogador</th><th class="hide-xs">Jogos</th><th>Ganhos</th><th>Perdas</th><th>Saldo</th></tr></thead>
        <tbody>${rows.map((p, i) => `<tr>
          <td class="pos-cell">${medal(i)}</td>
          <td><strong>${esc(p.name)}</strong><small class="sub">${plural(p.games, 'jogo', 'jogos')} · ${plural(p.wins, 'vitória', 'vitórias')}</small></td>
          <td class="hide-xs">${p.games}</td>
          <td class="pos">${p.gains ? amount(p.gains) : '—'}</td>
          <td class="neg">${p.losses ? amount(-p.losses) : '—'}</td>
          <td class="${netClass(p.net)}"><strong>${signed(p.net)}</strong></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Valores em R$. Ganhos = soma das noites no positivo · Perdas = soma das noites no negativo · Saldo = ganhos − perdas.</p>
    </section>
    <button class="btn block" data-action="share-ranking" data-id="${period}">Compartilhar ranking</button>`;
}

function rankingText(period) {
  const { rows, sessions } = rankingData(period);
  const title = period === 'geral' ? 'Ranking geral' : `Ranking de ${monthLabel(period).toLowerCase()}`;
  return [
    `♠ ${S.getState().settings.groupName} — ${title}`,
    `${plural(sessions.length, 'partida', 'partidas')}`,
    '',
    ...rows.map((p, i) => `${medal(i)} ${p.name}: ${signed(p.net)} (ganhos ${money(p.gains)} · perdas ${money(-p.losses)})`),
  ].join('\n');
}

function syncSection() {
  const s = S.syncInfo();
  if (s.mode === 'local') {
    return `
    <section class="card">
      <h2>Sincronização online</h2>
      <p class="muted small">Hoje os dados ficam só neste aparelho. Crie um grupo online para todos os celulares verem e lançarem buys na mesma mesa, em tempo real.</p>
      ${s.hasConfig ? '' : `
        <details class="setup"><summary>Configurar Firebase (uma vez só)</summary>
          <p class="muted small">Cole aqui o objeto <code>firebaseConfig</code> do seu projeto Firebase (passo a passo no README).</p>
          <textarea class="field mono" data-fbconfig rows="7" placeholder='{ "apiKey": "...", "authDomain": "...", "databaseURL": "https://...firebaseio.com", "projectId": "..." }'></textarea>
        </details>`}
      <div class="row wrap">
        <button class="btn primary" data-action="group-create">Criar grupo online</button>
        <button class="btn" data-action="group-join">Entrar com código</button>
      </div>
    </section>`;
  }
  const labels = { connecting: 'Conectando…', online: '🟢 Online', offline: '🟠 Sem conexão — os lançamentos serão enviados quando a internet voltar', error: `🔴 Erro: ${esc(s.error)}` };
  return `
    <section class="card">
      <h2>Sincronização online</h2>
      <p>${labels[s.mode] || ''}</p>
      <p class="muted small">Código do grupo: <strong class="mono">${esc(s.code)}</strong>. Envie o link abaixo para os amigos — ao abrir, o celular entra no grupo.</p>
      <div class="row wrap">
        <button class="btn primary" data-action="group-invite">Compartilhar link do grupo</button>
        <button class="btn danger" data-action="group-leave">Sair do grupo</button>
      </div>
    </section>`;
}

let adminGateOpen = false;
function viewAdmin() {
  const { settings, session, history } = S.getState();
  if (settings.adminPin && !S.isAdminDevice() && Date.now() >= adminUnlockedUntil && !adminGateOpen) {
    return `<section class="hero"><h1>Admin</h1><p class="muted">Área protegida por PIN.</p>
      <button class="btn primary big" data-action="admin-unlock">Desbloquear</button></section>`;
  }
  const locked = Boolean(session);
  const dis = locked ? 'disabled' : '';
  const t = S.buyTerms(settings);
  const rakeField = { perBuy: ['(fichas por buy)', settings.rakeValue, '1'], percent: ['(% do pote)', settings.rakeValue, '0.1'], fixed: ['(R$ na noite)', (settings.rakeValue / 100).toFixed(2), '0.01'], none: ['', 0, '1'] }[settings.rakeMode];
  return `
    <section class="hero small"><h1>Admin</h1><p class="muted">Configurações do grupo</p></section>
    ${pendingSection()}
    <section class="card">
      <h2>Aparelho do administrador</h2>
      ${!settings.adminPin
        ? '<p class="muted small">Defina um PIN do admin (abaixo, em Segurança) para escolher o aparelho que aprova os buys.</p>'
        : S.isAdminDevice()
          ? `<p>✅ Este aparelho é do admin: recebe os pedidos de buy, avisa quando chega um novo e aprova sem pedir o PIN.</p>
             <button class="btn" data-action="admin-device-off">Deixar de ser o aparelho do admin</button>`
          : `<p class="muted small">Use no celular de quem aprova os buys. Nos outros aparelhos, aprovar pede o PIN.</p>
             <button class="btn primary" data-action="admin-device-on">Usar este aparelho como admin</button>`}
    </section>
    ${syncSection()}
    <form class="card form" data-form="settings">
      <h2>Grupo</h2>
      <label>Nome do grupo<input class="field" name="groupName" value="${esc(settings.groupName)}" maxlength="40" /></label>
      <label><span>Jogadores frequentes <small class="muted">— um por linha</small></span>
        <textarea class="field" name="regulars" rows="6">${esc((settings.regulars || []).join('\n'))}</textarea></label>

      <h2>Caixa</h2>
      <div class="grid2">
        <label>Quem cuida do caixa<input class="field" name="caixaName" value="${esc(settings.caixaName)}" maxlength="30" placeholder="Nome" /></label>
        <label>WhatsApp do caixa<input class="field" name="caixaPhone" type="tel" inputmode="tel" value="${esc(settings.caixaPhone)}" placeholder="(11) 99999-9999" /></label>
      </div>
      <label><span>Chave Pix do caixa <small class="muted">— vai na mensagem para quem precisa pagar</small></span>
        <input class="field" name="caixaPix" value="${esc(settings.caixaPix)}" placeholder="CPF, celular, e-mail…" autocomplete="off" /></label>

      <h2>Chaves Pix dos jogadores</h2>
      <p class="muted small" style="margin:0">Aparecem na mensagem do caixa, ao lado de quem tem a receber.</p>
      <div class="pix-list">${S.knownPlayers().map((n) => `<label class="pix-row"><span>${esc(n)}</span>
        <input class="field" name="pix:${esc(n)}" value="${esc(S.pixOf(n))}" placeholder="CPF, celular, e-mail…" autocomplete="off" /></label>`).join('')}</div>

      <h2>Valores</h2>
      ${locked ? '<p class="notice">🔒 Valores travados durante a jogatina para não misturar buys de preços diferentes. Encerre a jogatina para alterar.</p>' : ''}
      <div class="grid2">
        <label>Valor do buy (R$)<input class="field" name="buyValue" type="number" step="0.01" min="0.01" inputmode="decimal" value="${(settings.buyValue / 100).toFixed(2)}" ${dis} required /></label>
        <label>Fichas por buy<input class="field" name="chipsPerBuy" type="number" step="1" min="1" inputmode="numeric" value="${settings.chipsPerBuy}" ${dis} required /></label>
      </div>
      <div class="grid2">
        <label>Tipo de rake
          <select class="field" name="rakeMode" ${dis}>
            ${[['perBuy', 'Fichas por buy'], ['percent', '% do pote'], ['fixed', 'Valor fixo na noite (R$)'], ['none', 'Sem rake']]
              .map(([v, l]) => `<option value="${v}" ${settings.rakeMode === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <label ${settings.rakeMode === 'none' ? 'hidden' : ''}><span>Valor do rake <span class="muted">${rakeField[0]}</span></span>
          <input class="field" name="rakeValue" type="number" step="${rakeField[2]}" min="0" inputmode="decimal" value="${rakeField[1]}" ${dis} /></label>
      </div>
      <p class="notice info">Cada buy: <strong>${money(t.value)}</strong> = ${num(settings.chipsPerBuy)} fichas (1 ficha = ${money(Math.round(t.chipValue))})${t.rakeChips ? ` · ${plural(t.rakeChips, 'ficha', 'fichas')} (${money(t.rake)}) vão para o rake · <strong>${num(t.chips)} fichas entram em jogo</strong>` : ''}.</p>
      <label>Como os buys são pagos
        <select class="field" name="paymentMode" ${dis}>
          <option value="acerto" ${settings.paymentMode === 'acerto' ? 'selected' : ''}>Acerto no final (Pix entre jogadores)</option>
          <option value="caixa" ${settings.paymentMode === 'caixa' ? 'selected' : ''}>Na hora, para um caixa/banca</option>
        </select></label>

      <h2>Conferência</h2>
      <label class="switch"><input type="checkbox" name="requireSignature" ${settings.requireSignature ? 'checked' : ''} /> Exigir assinatura do jogador em cada buy</label>
      <label class="switch"><input type="checkbox" name="requireApproval" ${settings.requireApproval ? 'checked' : ''} /> Cada buy precisa ser aprovado pelo admin</label>
      <label class="switch"><input type="checkbox" name="requireConfirmAtClose" ${settings.requireConfirmAtClose ? 'checked' : ''} /> Cada jogador marca “Conferido” no fechamento</label>

      <h2>Segurança</h2>
      <label><span>PIN do admin <small class="muted">— protege esta página, anulação de buys e exclusões (vazio = sem PIN)</small></span>
        <input class="field" name="adminPin" type="password" inputmode="numeric" autocomplete="new-password" value="${esc(settings.adminPin)}" maxlength="8" /></label>

      <button class="btn primary big block">Salvar configurações</button>
    </form>

    <section class="card">
      <h2>Juntar jogadores</h2>
      <p class="muted small">Para quando a mesma pessoa aparece com dois nomes (ex.: “Tita” e “Titã”). O histórico, o ranking e a chave Pix passam a usar o nome certo.</p>
      <div class="form merge"><div class="grid2">
        <label for="merge-from">Nome errado<select class="field" id="merge-from">${S.knownPlayers().map((n) => `<option>${esc(n)}</option>`).join('')}</select></label>
        <label for="merge-to">Nome certo<select class="field" id="merge-to">${S.knownPlayers().map((n, i) => `<option ${i === 1 ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      </div></div>
      <button class="btn" data-action="merge-players">Juntar</button>
    </section>

    <section class="card">
      <h2>Backup</h2>
      <p class="muted small">Exporte um backup de vez em quando (${(S.storageSize() / 1024).toFixed(0)} KB em cache neste aparelho).</p>
      <div class="row wrap">
        <button class="btn" data-action="export">Exportar backup</button>
        <label class="btn">Importar backup<input type="file" accept="application/json,.json" data-import hidden /></label>
      </div>
    </section>

    <section class="card danger-zone">
      <h2>Zona de perigo</h2>
      <div class="row wrap">
        <button class="btn danger" data-action="cancel-session" ${session ? '' : 'disabled'}>Descartar jogatina atual</button>
        <button class="btn danger" data-action="clear-history" ${history.length ? '' : 'disabled'}>Mandar histórico para a lixeira</button>
      </div>
    </section>`;
}

// ---------- Modais de jogador / buy ----------
/** Buy em etapas: 1) quantidade  2) uma assinatura por buy  3) pedido único ao admin. */
function openBuy(playerId) {
  const { settings } = S.getState();
  const p = S.getPlayer(playerId);
  if (!p) return;
  const t = S.buyTerms(settings);
  const needSig = settings.requireSignature;
  const approval = settings.requireApproval && !S.isAdminDevice();
  const finalLabel = (n) => {
    const q = n > 1 ? ` (${n} buys)` : '';
    return settings.requireApproval ? (S.isAdminDevice() ? `Confirmar e aprovar${q}` : `Pedir aprovação${q}`) : `Confirmar${q}`;
  };
  let qty = 1;
  const signatures = [];

  const stepQty = () => {
    const first = S.playerStats(playerId).buys + 1;
    openModal(
      `<header><h2>Buy · ${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
       <p class="hint">Quantos buys ${esc(p.name)} vai pegar agora?</p>
       <div class="qty">
         <button type="button" class="qty-btn" data-dec aria-label="Menos um">−</button>
         <output data-qty>${qty}</output>
         <button type="button" class="qty-btn" data-inc aria-label="Mais um">+</button>
       </div>
       <div class="buy-amount"><strong data-total></strong><span data-chips></span></div>
       <p class="notice sig-count" data-sigs></p>
       <footer><button type="button" class="btn ghost" data-close>Cancelar</button>
         <button type="button" class="btn primary" data-next></button></footer>`,
      (root) => {
        const update = () => {
          root.querySelector('[data-qty]').textContent = qty;
          root.querySelector('[data-total]').textContent = money(t.value * qty);
          root.querySelector('[data-chips]').innerHTML = `${num(t.chips * qty)} fichas${t.rakeChips ? `<small>+ ${num(t.rakeChips * qty)} de rake</small>` : ''}`;
          const nums = qty > 1 ? `buys #${first} a #${first + qty - 1}` : `buy #${first}`;
          root.querySelector('[data-sigs]').innerHTML = needSig
            ? `✍️ ${esc(p.name)} vai precisar assinar <strong>${plural(qty, 'vez', 'vezes')}</strong> — uma para cada buy (${nums}).${approval ? '<br>Depois vai <strong>um pedido só</strong> para o admin aprovar.' : ''}`
            : `${qty > 1 ? `${qty} buys` : '1 buy'} (${nums}).${approval ? ' Vai um pedido só para o admin aprovar.' : ''}`;
          root.querySelector('[data-dec]').disabled = qty <= 1;
          root.querySelector('[data-inc]').disabled = qty >= S.MAX_BUYS_PER_REQUEST;
          root.querySelector('[data-next]').textContent = needSig ? `Assinar (1 de ${qty})` : finalLabel(qty);
        };
        root.querySelector('[data-dec]').addEventListener('click', () => { qty = Math.max(1, qty - 1); update(); });
        root.querySelector('[data-inc]').addEventListener('click', () => { qty = Math.min(S.MAX_BUYS_PER_REQUEST, qty + 1); update(); });
        root.querySelector('[data-next]').addEventListener('click', (e) => {
          if (needSig) return stepSign(0);
          e.currentTarget.disabled = true;
          submit();
        });
        update();
      },
    );
  };

  const stepSign = (i) => {
    const first = S.playerStats(playerId).buys + 1;
    const last = i === qty - 1;
    openModal(
      `<header><h2>Assinatura ${i + 1} de ${qty}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
       ${qty > 1 ? `<div class="sig-steps" aria-hidden="true">${Array.from({ length: qty }, (_, k) => `<i class="${k < i ? 'done' : k === i ? 'now' : ''}"></i>`).join('')}</div>` : ''}
       <div class="buy-amount"><strong>Buy #${first + i}</strong><span>${money(t.value)} · ${num(t.chips)} fichas</span></div>
       <p class="hint"><strong>${esc(p.name)}</strong>, assine para confirmar este buy.</p>
       <div class="sigwrap"><canvas class="sig"></canvas><span class="sig-ph">assine aqui</span>
         <button type="button" class="link" data-clear>Limpar</button></div>
       <footer>
         <button type="button" class="btn ghost" data-back>${i === 0 ? 'Voltar' : '← Anterior'}</button>
         <button type="button" class="btn primary" data-ok disabled>${last ? finalLabel(1) : `Próxima →`}</button>
       </footer>`,
      (root) => {
        const ok = root.querySelector('[data-ok]');
        const ph = root.querySelector('.sig-ph');
        const pad = new SignaturePad(root.querySelector('canvas'), {
          onChange: (empty) => { ok.disabled = empty; ph.hidden = true; },
        });
        root.querySelector('[data-clear]').addEventListener('click', () => { pad.clear(); ph.hidden = false; });
        root.querySelector('[data-back]').addEventListener('click', () => (i === 0 ? stepQty() : stepSign(i - 1)));
        ok.addEventListener('click', () => {
          ok.disabled = true; // evita toque duplo
          signatures[i] = pad.toDataURL();
          if (last) submit();
          else stepSign(i + 1);
        });
      },
    );
  };

  const submit = () => {
    ownRequest = true;
    const entries = attempt(() => S.addBuys(playerId, qty, needSig ? signatures.slice(0, qty) : []));
    ownRequest = false;
    if (!entries) return stepQty();
    // No aparelho do admin, confirmar já é a aprovação.
    const pending = entries[0].pending;
    const approved = pending && S.isAdminDevice() && S.approveRequest(entries[0].requestId);
    closeModal();
    const what = qty > 1 ? `${qty} buys` : `Buy #${entries[0].seq}`;
    const msg = pending && !approved
      ? `Pedido de ${qty > 1 ? `${qty} buys` : 'buy'} de ${p.name} enviado — aguardando aprovação do admin`
      : `${what} de ${p.name} registrado${qty > 1 ? 's' : ''}${approved ? ` e aprovado${qty > 1 ? 's' : ''}` : ''}`;
    toast(msg, {
      action: 'Desfazer',
      timeout: 8000,
      onAction: () => { S.voidBuys(entries.map((e) => e.id), 'Desfeito logo após o registro'); toast('Desfeito'); },
    });
  };

  stepQty();
}

function openPlayer(playerId) {
  const { session } = S.getState();
  const p = S.getPlayer(playerId);
  if (!p) return;
  const st = S.playerStats(playerId);
  const entries = session.ledger.filter((e) => e.type === 'buy' && e.playerId === playerId);
  const out = p.cashout;
  const outRes = out ? S.previewCashOut(playerId, out.chips) : null;
  openModal(
    `<header><h2>${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
     <p class="muted">${plural(st.buys, 'buy válido', 'buys válidos')} · ${money(st.paid)}${st.pending ? ` · ${st.pending} aguardando aprovação` : ''}</p>
     ${out
       ? `<div class="out-box"><strong>🏁 Encerrou às ${hour(out.at)} com ${num(out.chips)} fichas</strong>
            <span>Recebe ${money(outRes.payout)} · saldo <strong class="${netClass(outRes.net)}">${signed(outRes.net)}</strong>${outRes.exact ? '' : ' (estimado até o fechamento)'}</span></div>`
       : st.buys ? `<button type="button" class="btn primary block" data-cashout>🏁 Encerrar jogo de ${esc(p.name)}</button>` : ''}
     <button type="button" class="btn small ghost pix-btn" data-pix>Pix: ${esc(S.pixOf(p.name) || 'cadastrar chave')} ✎</button>
     <ul class="entries">
       ${entries.map((e) => `<li class="${e.voided ? 'voided' : ''}">
          <div><strong>${e.voided ? 'Buy anulado' : e.pending ? '⏳ Aguardando aprovação' : `Buy #${e.seq}`}</strong><small>${hour(e.at)} · ${money(e.value)}</small>
            ${e.voided ? `<small class="neg">Motivo: ${esc(e.voided.reason)}</small>` : ''}</div>
          ${sigImg(e)}
          ${e.voided || out ? '' : `<button class="btn small ghost" data-void="${e.id}">Anular</button>`}
        </li>`).join('') || '<li class="muted">Nenhum buy ainda.</li>'}
     </ul>
     <footer>
       <button type="button" class="btn ghost" data-rename>Renomear</button>
       ${out
         ? '<button type="button" class="btn danger" data-undo-out>Desfazer saída</button>'
         : `<button type="button" class="btn danger" data-remove ${st.buys ? 'disabled title="Anule os buys antes"' : ''}>Remover da mesa</button>`}
     </footer>`,
    (root) => {
      loadSignatures(root, session.id);
      root.querySelectorAll('[data-void]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!(await requireAdmin('anular um buy'))) return openPlayer(playerId);
          const reason = await ask({
            title: 'Anular buy',
            body: 'O buy continua no registro, riscado, com o motivo. Nada é apagado.',
            input: 'placeholder="Motivo (ex.: registrado em dobro)" maxlength="80"',
            confirmText: 'Anular',
            danger: true,
            validate: (v) => (v ? null : 'Informe o motivo'),
          });
          if (reason) { S.voidBuy(b.dataset.void, reason); toast('Buy anulado'); }
          openPlayer(playerId);
        }),
      );
      root.querySelector('[data-pix]').addEventListener('click', async () => {
        const v = await ask({ title: `Chave Pix de ${p.name}`, input: `value="${esc(S.pixOf(p.name))}" placeholder="CPF, celular, e-mail…"`, confirmText: 'Salvar' });
        if (v !== null) { S.setPix(p.name, v); toast('Chave Pix salva'); }
        openPlayer(playerId);
      });
      root.querySelector('[data-rename]').addEventListener('click', async () => {
        const name = await ask({ title: 'Renomear', input: `value="${esc(p.name)}" maxlength="30"`, confirmText: 'Salvar' });
        if (name) attempt(() => S.renamePlayer(playerId, name));
        openPlayer(playerId);
      });
      root.querySelector('[data-cashout]')?.addEventListener('click', () => openCashOut(playerId));
      root.querySelector('[data-undo-out]')?.addEventListener('click', async () => {
        if (!(await requireAdmin('desfazer a saída de um jogador'))) return openPlayer(playerId);
        const ok = await confirmDialog('Desfazer saída?', `${esc(p.name)} volta para a mesa e a contagem dele será refeita no fechamento.`, { confirmText: 'Desfazer saída', danger: true });
        if (ok) { attempt(() => S.undoCashOut(playerId)); toast(`${p.name} voltou para a mesa`); }
        openPlayer(playerId);
      });
      root.querySelector('[data-remove]')?.addEventListener('click', async () => {
        if (await confirmDialog('Remover jogador?', `${esc(p.name)} sai da mesa.`, { confirmText: 'Remover', danger: true })) {
          attempt(() => S.removePlayer(playerId));
        }
      });
    },
  );
}

/** Encerrar o jogo de um jogador só: conta as fichas dele, mostra o valor e trava. */
function openCashOut(playerId, preset = '') {
  const { settings } = S.getState();
  const p = S.getPlayer(playerId);
  if (!p) return;
  const st = S.playerStats(playerId);
  const t = S.buyTerms(settings);
  openModal(
    `<header><h2>Encerrar jogo · ${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
     <p class="muted">${plural(st.buys, 'buy', 'buys')} · pagou ${money(st.paid)}${st.pending ? ` · <span class="wait">${st.pending} aguardando aprovação</span>` : ''}</p>
     ${st.pending ? '<p class="notice">Aprove ou recuse os buys pendentes dele antes de encerrar.</p>' : ''}
     <label class="count big-count"><span>Fichas de ${esc(p.name)}</span>
       <input class="field" data-co inputmode="numeric" pattern="[0-9]*" placeholder="digite as fichas" value="${esc(preset)}" autocomplete="off" /></label>
     <button type="button" class="btn small ghost" data-co-zero>Saiu zerado (0 fichas)</button>
     <div class="buy-amount"><span>Recebe<small data-co-net></small></span><strong data-co-pay>—</strong></div>
     <p class="muted small">${settings.rakeMode === 'perBuy' || settings.rakeMode === 'none'
       ? `1 ficha = ${money(Math.round((t.value - t.rake) / t.chips))}. O valor já é o final.`
       : 'Com esse tipo de rake, o valor é uma estimativa e se confirma no fechamento.'}</p>
     <p class="error" hidden></p>
     <p class="muted small" data-co-why></p>
     <footer><button type="button" class="btn ghost" data-close>Cancelar</button>
       <button type="button" class="btn primary" data-co-go disabled>Encerrar jogo</button></footer>`,
    (root) => {
      const input = root.querySelector('[data-co]');
      const why = root.querySelector('[data-co-why]');
      const go = root.querySelector('[data-co-go]');
      const err = root.querySelector('.error');
      const update = () => {
        input.value = input.value.replace(/\D/g, '');
        const has = input.value !== '';
        const chips = has ? parseInt(input.value, 10) : 0;
        const r = S.previewCashOut(playerId, chips);
        root.querySelector('[data-co-pay]').textContent = has ? money(r.payout) : '—';
        const netEl = root.querySelector('[data-co-net]');
        netEl.textContent = has ? `saldo ${signed(r.net)}` : '';
        netEl.className = has ? netClass(r.net) : '';
        const over = has && chips > r.maxChips;
        err.hidden = !over;
        err.textContent = over ? `Não pode passar de ${num(r.maxChips)} fichas (total ainda em jogo).` : '';
        go.disabled = !has || over || st.pending > 0;
        why.textContent = st.pending ? 'Aprove ou recuse os buys pendentes dele primeiro.'
          : !has ? `Digite quantas fichas ${p.name} tem (ou toque em “Saiu zerado”).`
          : over ? '' : `Ao encerrar, ${p.name} confirma a contagem de ${num(parseInt(input.value, 10))} fichas.`;
      };
      input.addEventListener('input', update);
      root.querySelector('[data-co-zero]').addEventListener('click', () => { input.value = '0'; update(); });
      go.addEventListener('click', async () => {
        const chips = parseInt(input.value, 10);
        if (!(await requireAdmin('encerrar o jogo de um jogador'))) return openCashOut(playerId, String(chips));
        if (attempt(() => S.cashOut(playerId, chips)) === undefined && S.getPlayer(playerId)?.cashout) showCashOutDone(playerId);
        else if (!S.getPlayer(playerId)?.cashout) openCashOut(playerId, String(chips));
      });
      update();
      input.focus();
    },
  );
}

function cashOutMessage(p, r) {
  const { settings } = S.getState();
  const head = `♠ ${settings.groupName} — saída de ${p.name} (${hour(p.cashout.at)})`;
  if (r.net < 0) return `${head}\n\n*A pagar:*\n${p.name} - ${money(-r.net)} - Pix do caixa: ${caixaPix() || 'não cadastrado'}`;
  if (r.net > 0) return `${head}\n\n*A receber:*\n${p.name} - ${money(r.net)} - Pix: ${S.pixOf(p.name) || 'não cadastrado'}`;
  return `${head}\n\n${p.name} saiu zerado (nada a pagar ou receber).`;
}

function showCashOutDone(playerId) {
  const { settings } = S.getState();
  const p = S.getPlayer(playerId);
  const r = S.previewCashOut(playerId, p.cashout.chips);
  const caixa = settings.paymentMode !== 'caixa';
  const wa = whatsappLink(settings.caixaPhone, cashOutMessage(p, r));
  openModal(
    `<header><h2>🏁 ${esc(p.name)} saiu</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
     <div class="buy-amount"><span>${num(p.cashout.chips)} fichas<small>${plural(r.buys, 'buy', 'buys')} · pagou ${money(r.paid)}</small></span><strong>${money(r.payout)}</strong></div>
     <p class="out-net">${r.net < 0 ? `${esc(p.name)} <strong>paga ${money(-r.net)}</strong>` : r.net > 0 ? `${esc(p.name)} <strong>recebe ${money(r.net)}</strong>` : `${esc(p.name)} saiu <strong>zerado</strong>`}${caixa ? ' no acerto com o caixa.' : '.'}${r.exact ? '' : ' (estimado)'}</p>
     <p class="muted small">A contagem dele está travada e entra sozinha no fechamento da jogatina.</p>
     <footer>
       <button type="button" class="btn ghost" data-close>Fechar</button>
       ${wa ? `<a class="btn primary whatsapp" href="${esc(wa)}" target="_blank" rel="noopener">Avisar o caixa</a>` : ''}
     </footer>`,
  );
}

function openAudit(sessionId) {
  const s = S.getHistorySession(sessionId);
  if (!s) return;
  const nameOf = (id) => s.players.find((p) => p.id === id)?.name ?? '—';
  const buys = s.ledger.filter((e) => e.type === 'buy');
  openModal(
    `<header><h2>Registro de buys</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
     <ul class="entries">${buys.map((e) => `<li class="${e.voided ? 'voided' : ''}">
        <div><strong>${esc(nameOf(e.playerId))} · ${e.voided ? 'anulado' : `#${e.seq}`}</strong><small>${hour(e.at)} · ${money(e.value)}</small>
        ${e.voided ? `<small class="neg">Motivo: ${esc(e.voided.reason)}</small>` : ''}</div>
        ${sigImg(e)}
      </li>`).join('')}</ul>`,
    (root) => loadSignatures(root, s.id),
  );
}

// ---------- Grupo online ----------
function readPastedConfig() {
  const raw = app.querySelector('[data-fbconfig]')?.value.trim();
  if (!raw) return null;
  // Aceita tanto JSON quanto o trecho JS copiado do console do Firebase.
  const obj = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,\s*}/g, '}');
  try {
    return JSON.parse(obj);
  } catch {
    throw new Error('Não consegui ler a configuração do Firebase colada');
  }
}

async function createGroup() {
  let config;
  try { config = readPastedConfig(); } catch (err) { return toast(err.message, { type: 'error' }); }
  if (!S.syncInfo().hasConfig && !config) return toast('Cole a configuração do Firebase primeiro', { type: 'error' });
  const ok = await confirmDialog('Criar grupo online?', 'Os dados deste aparelho (jogatina atual e histórico) serão enviados para o grupo. Depois é só compartilhar o link com os amigos.', { confirmText: 'Criar grupo' });
  if (!ok) return;
  toast('Criando grupo…', { timeout: 15000 });
  try {
    await S.createGroup(config);
    location.hash = '#/admin';
    location.reload();
  } catch (err) {
    toast(`Não foi possível criar: ${err.message}`, { type: 'error', timeout: 8000 });
  }
}

async function joinGroup(code, config) {
  try {
    await S.joinGroup(code, config);
    location.reload();
  } catch (err) {
    toast(`Não foi possível entrar: ${err.message}`, { type: 'error', timeout: 8000 });
  }
}

/** Link de convite: ?g=CODIGO (&c=config, se o Firebase foi configurado pelo Admin). */
async function handleInviteLink() {
  const params = new URLSearchParams(location.search);
  const code = params.get('g');
  if (!code) return;
  let config = null;
  try { config = params.get('c') ? JSON.parse(atob(params.get('c'))) : null; } catch { /* ignora */ }
  window.history.replaceState(null, '', location.pathname + location.hash);
  if (S.syncInfo().code === code) return;
  const ok = await confirmDialog('Entrar no grupo?', 'Este celular vai passar a mostrar e lançar os buys da mesa compartilhada do grupo.', { confirmText: 'Entrar' });
  if (ok) joinGroup(code, config);
}

// ---------- Roteamento ----------
function route() {
  const [, name = '', arg] = (location.hash.slice(1) || '/').split('/');
  return { name: name || 'mesa', arg };
}

/** Guarda o que o usuário está digitando para não perder quando outro celular atualizar a tela. */
function snapshotInputs() {
  return [...app.querySelectorAll('[data-form] [name]')]
    .filter((el) => el.dataset.dirty)
    .map((el) => ({ sel: `[data-form="${el.form.dataset.form}"] [name="${CSS.escape(el.name)}"]`, value: el.type === 'checkbox' ? el.checked : el.value, focused: el === document.activeElement }));
}
function restoreInputs(saved) {
  for (const s of saved) {
    const el = app.querySelector(s.sel);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = s.value;
    else el.value = s.value;
    el.dataset.dirty = '1';
    if (s.focused) el.focus();
  }
}

let renderedKey = '';
function render() {
  const { name, arg } = route();
  const { settings, session } = S.getState();
  renderSync();
  document.getElementById('brand-name').textContent = settings.groupName || S.DEFAULT_SETTINGS.groupName;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === name || (a.dataset.nav === 'historico' && (name === 'resultado' || name === 'ranking')) || (a.dataset.nav === 'mesa' && name === 'fechar');
    a.classList.toggle('active', active);
  });

  // Na tela de fechamento, só atualiza os números se os jogadores forem os mesmos.
  const key = `${name}/${arg}/${session?.id}/${session?.players.map((p) => p.id).join(',')}/${settings.requireConfirmAtClose}`;
  if (name === 'fechar' && session && key === renderedKey) {
    app.querySelector('.summary').outerHTML = summaryBar();
    updateFechar();
    return;
  }
  renderedKey = key;

  const saved = snapshotInputs();
  const views = { mesa: viewMesa, fechar: viewFechar, resultado: () => viewResultado(arg), historico: viewHistorico, ranking: () => viewRanking(arg), admin: viewAdmin };
  app.innerHTML = (views[name] || viewMesa)();
  app.dataset.view = name;
  restoreInputs(saved);
  if (name === 'fechar' && session) updateFechar();
  if (session && app.querySelector('.pending-card [data-sig]')) loadSignatures(app.querySelector('.pending-card'), session.id);
}

// Avisa o aparelho do admin quando chega um pedido de buy de outro celular.
let ownRequest = false;
let knownPending = new Set(S.pendingBuys().map((e) => e.id));
S.subscribe(() => {
  const now = S.pendingBuys();
  const fresh = now.filter((e) => !knownPending.has(e.id));
  knownPending = new Set(now.map((e) => e.id));
  if (!fresh.length || ownRequest || !S.isAdminDevice()) return;
  const requests = new Set(fresh.map((e) => e.requestId || e.id));
  const name = S.getPlayer(fresh[0].playerId)?.name ?? 'Alguém';
  const text = requests.size > 1 ? `${requests.size} novos pedidos de buy` : fresh.length > 1 ? `${name} pediu ${fresh.length} buys — aprovar?` : `${name} pediu um buy — aprovar?`;
  toast(text, {
    action: 'Ver', timeout: 10000, onAction: () => { location.hash = '#/'; window.scrollTo(0, 0); },
  });
  navigator.vibrate?.([150, 80, 150]);
});

window.addEventListener('hashchange', () => { adminGateOpen = false; renderedKey = ''; app.innerHTML = ''; render(); window.scrollTo(0, 0); });
S.subscribe(render);

// ---------- Eventos ----------
const guarded = new Set(['cancel-session', 'clear-history', 'group-leave', 'delete-session']);
app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, name } = el.dataset;
  if (guarded.has(action) && !(await requireAdmin('esta ação'))) return;
  switch (action) {
    case 'buy': return openBuy(id);
    case 'player': return openPlayer(id);
    case 'player-quick': {
      const p = attempt(() => S.addPlayer(name));
      if (p) toast(`${p.name} entrou na mesa`);
      return;
    }
    case 'pending-toggle':
      pendingNames = pendingNames.includes(name) ? pendingNames.filter((n) => n !== name) : [...pendingNames, name];
      return render();
    case 'start':
      el.disabled = true;
      await attemptAsync(() => S.startSession(pendingNames));
      if (S.getState().session) pendingNames = [];
      return render();
    case 'close-session': {
      const r = S.settlement(S.getState().session.draft.counts);
      const ok = await confirmDialog('Encerrar jogatina?', `Pote de <strong>${money(r.totals.pot)}</strong>, ${num(r.totals.chips)} fichas conferidas. Depois de encerrar, não dá mais para lançar buys.`, { confirmText: 'Encerrar' });
      if (!ok) return;
      toast('Encerrando…', { timeout: 15000 });
      const sid = await attemptAsync(() => S.closeSession());
      if (sid) { toast('Jogatina encerrada'); location.hash = `#/resultado/${sid}`; }
      return;
    }
    case 'share': {
      const text = shareText(S.getHistorySession(id));
      if (navigator.share) {
        try { await navigator.share({ text }); return; } catch { /* cancelado → copia */ }
      }
      try { await navigator.clipboard.writeText(text); toast('Resumo copiado — cole no grupo'); } catch { toast('Não foi possível copiar', { type: 'error' }); }
      return;
    }
    case 'audit': return openAudit(id);
    case 'approve-request': {
      if (!(await requireAdmin('aprovar buys'))) return;
      const n = S.approveRequest(id);
      if (n) toast(n > 1 ? `${n} buys aprovados ✓` : 'Buy aprovado ✓');
      return;
    }
    case 'reject-request': {
      if (!(await requireAdmin('recusar buys'))) return;
      const n = S.pendingRequests().find((r) => r.key === id)?.entries.length || 0;
      const reason = await ask({ title: n > 1 ? `Recusar ${n} buys` : 'Recusar buy', body: 'O pedido fica no registro como recusado. Nada entra no pote.', input: 'placeholder="Motivo (opcional)" maxlength="80"', confirmText: 'Recusar', danger: true });
      if (reason === null) return;
      if (S.rejectRequest(id, reason)) toast(n > 1 ? `${n} buys recusados` : 'Buy recusado');
      return;
    }
    case 'admin-device-on':
      if (!(await requireAdmin('definir o aparelho do admin'))) return;
      S.setAdminDevice(true);
      toast('Este aparelho agora aprova os buys');
      return;
    case 'admin-device-off':
      S.setAdminDevice(false);
      adminUnlockedUntil = 0;
      toast('Este aparelho não é mais o do admin');
      return;
    case 'share-ranking': {
      const text = rankingText(id);
      if (navigator.share) {
        try { await navigator.share({ text }); return; } catch { /* cancelado → copia */ }
      }
      try { await navigator.clipboard.writeText(text); toast('Ranking copiado — cole no grupo'); } catch { toast('Não foi possível copiar', { type: 'error' }); }
      return;
    }
    case 'copy-caixa': {
      try { await navigator.clipboard.writeText(caixaMessage(S.getHistorySession(id))); toast('Mensagem copiada'); } catch { toast('Não foi possível copiar', { type: 'error' }); }
      return;
    }
    case 'caixa-phone': {
      const phone = await ask({ title: 'WhatsApp do caixa', body: 'Número de quem cuida do caixa, com DDD. Fica salvo para as próximas.', input: 'type="tel" inputmode="tel" placeholder="(11) 99999-9999"', confirmText: 'Salvar', validate: (v) => (v.replace(/\D/g, '').length >= 10 ? null : 'Número inválido') });
      if (phone) { S.updateSettings({ caixaPhone: phone }); toast('Pronto! Agora toque em “Enviar para o caixa”'); }
      return;
    }
    case 'delete-session': {
      const s = S.getHistorySession(id);
      if (!s) return;
      const ok = await confirmDialog('Mandar para a lixeira?', `A partida de <strong>${day(s.startedAt)}</strong> (pote de ${money(s.result.totals.pot)}) sai do histórico e do ranking. Dá para restaurar pela lixeira, no fim do Histórico.`, { confirmText: 'Mandar para a lixeira', danger: true });
      if (!ok) return;
      S.deleteHistorySession(id);
      toast('Partida na lixeira', { action: 'Desfazer', timeout: 8000, onAction: () => { S.restoreHistorySession(id); toast('Partida restaurada'); } });
      if (location.hash.startsWith('#/resultado/')) location.hash = '#/historico';
      return;
    }
    case 'approve-all': {
      if (!(await requireAdmin('aprovar buys'))) return;
      const n = S.pendingRequests().reduce((a, r) => a + S.approveRequest(r.key), 0);
      if (n) toast(`${plural(n, 'buy aprovado', 'buys aprovados')} ✓`);
      return;
    }
    case 'settle': {
      if (!(await requireAdmin('marcar acertos'))) return;
      const s = S.getHistorySession(id);
      const item = s && S.settlementItems(s).find((x) => x.playerId === el.dataset.player);
      if (item) S.setSettled(id, item.playerId, !item.settledAt);
      return;
    }
    case 'settle-all':
      if (!(await requireAdmin('marcar acertos'))) return;
      if (await confirmDialog('Marcar todos como acertados?', 'Use quando todos os Pix desta noite já foram feitos.', { confirmText: 'Marcar todos' })) {
        S.settleAll(id);
        toast('Acertos marcados ✓');
      }
      return;
    case 'restore-session':
      S.restoreHistorySession(id);
      toast('Partida restaurada');
      return;
    case 'purge-session':
      if (!(await requireAdmin('excluir de vez'))) return;
      if (await confirmDialog('Excluir de vez?', 'A partida e as assinaturas dela somem para sempre. Não dá para desfazer.', { confirmText: 'Excluir de vez', danger: true })) {
        S.purgeHistorySession(id);
        toast('Partida excluída');
      }
      return;
    case 'empty-trash':
      if (!(await requireAdmin('esvaziar a lixeira'))) return;
      if (await confirmDialog('Esvaziar a lixeira?', `${plural(S.getState().trash.length, 'partida some', 'partidas somem')} para sempre, com as assinaturas. Não dá para desfazer.`, { confirmText: 'Esvaziar', danger: true })) {
        S.emptyTrash();
        toast('Lixeira esvaziada');
      }
      return;
    case 'merge-players': {
      const from = app.querySelector('#merge-from').value;
      const to = app.querySelector('#merge-to').value;
      if (S.nameKey(from) === S.nameKey(to)) return toast('Escolha dois nomes diferentes', { type: 'error' });
      const pv = S.mergePreview(from, to);
      if (pv.conflicts.length || pv.inSession) return toast(`${from} e ${to} jogaram na mesma noite. Não dá para juntar.`, { type: 'error', timeout: 7000 });
      if (!(await requireAdmin('juntar jogadores'))) return;
      const ok = await confirmDialog('Juntar jogadores?', `<strong>${esc(from)}</strong> vira <strong>${esc(to)}</strong> em ${plural(pv.sessions, 'partida', 'partidas')}, no ranking, nos frequentes e no Pix.`, { confirmText: 'Juntar' });
      if (!ok) return;
      const n = attempt(() => S.mergePlayers(from, to));
      if (n !== undefined) toast(`Pronto: ${from} agora é ${to}`);
      return;
    }
    case 'admin-unlock':
      if (await requireAdmin('abrir as configurações')) { adminGateOpen = true; render(); }
      return;
    case 'group-create': return createGroup();
    case 'group-join': {
      let config;
      try { config = readPastedConfig(); } catch (err) { return toast(err.message, { type: 'error' }); }
      const code = await ask({ title: 'Entrar em um grupo', body: 'Cole o código ou o link do grupo.', input: 'placeholder="Código ou link" autocapitalize="off"', confirmText: 'Entrar' });
      if (!code) return;
      let c = code;
      let cfg = config;
      try {
        const u = new URL(code);
        c = u.searchParams.get('g') || code;
        if (u.searchParams.get('c')) cfg = JSON.parse(atob(u.searchParams.get('c')));
      } catch { /* não é link */ }
      return joinGroup(c, cfg);
    }
    case 'group-invite': {
      const link = S.inviteLink();
      const text = `♠ Entra no grupo do poker: ${link}`;
      if (navigator.share) {
        try { await navigator.share({ text }); return; } catch { /* cancelado → copia */ }
      }
      try { await navigator.clipboard.writeText(link); toast('Link copiado — mande no grupo'); } catch { await ask({ title: 'Link do grupo', input: `value="${esc(link)}" readonly`, confirmText: 'OK' }); }
      return;
    }
    case 'group-leave':
      if (await confirmDialog('Sair do grupo?', 'Este celular volta a usar só os dados locais. Os dados do grupo continuam online para os outros.', { confirmText: 'Sair', danger: true })) {
        S.leaveGroup();
        location.reload();
      }
      return;
    case 'export': {
      const blob = new Blob([S.exportData()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `poker-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    case 'cancel-session':
      if (await confirmDialog('Descartar jogatina?', 'Todos os buys desta jogatina serão perdidos. Isso não pode ser desfeito.', { confirmText: 'Descartar', danger: true })) {
        try {
          await S.cancelSession();
          toast('Jogatina descartada');
        } catch (err) {
          toast(err.message, { type: 'error', timeout: 7000 });
        }
      }
      return;
    case 'clear-history':
      if (await confirmDialog('Mandar histórico para a lixeira?', 'Todas as jogatinas encerradas vão para a lixeira (dá para restaurar no fim do Histórico).', { confirmText: 'Mandar tudo', danger: true })) {
        S.clearHistory();
        toast('Histórico na lixeira');
      }
      return;
    default:
  }
});

app.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const data = new FormData(form);
  form.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
  switch (form.dataset.form) {
    case 'pending-add': {
      const n = S.canonicalName(data.get('name'));
      if (!n) return;
      if (pendingNames.some((x) => S.nameKey(x) === S.nameKey(n))) return toast(`"${n}" já está na lista`, { type: 'error' });
      pendingNames.push(n);
      render();
      app.querySelector('[data-form="pending-add"] input')?.focus();
      return;
    }
    case 'player-add': {
      const p = attempt(() => S.addPlayer(data.get('name')));
      if (p) {
        toast(`${p.name} entrou na mesa`);
        app.querySelector('[data-form="player-add"] input')?.focus();
      }
      return;
    }
    case 'settings': {
      const { session } = S.getState();
      const pix = { ...S.getState().settings.pix };
      for (const [k, v] of data.entries()) {
        if (!k.startsWith('pix:')) continue;
        const key = S.pixKey(k.slice(4));
        if (String(v).trim()) pix[key] = String(v).trim();
        else delete pix[key];
      }
      const patch = {
        groupName: String(data.get('groupName') || '').trim() || S.DEFAULT_SETTINGS.groupName,
        caixaName: String(data.get('caixaName') || '').trim(),
        caixaPhone: String(data.get('caixaPhone') || '').trim(),
        caixaPix: String(data.get('caixaPix') || '').trim(),
        pix,
        regulars: String(data.get('regulars') || '').split(/[\n,]/).map((n) => n.trim().replace(/\s+/g, ' ')).filter(Boolean),
        requireSignature: data.get('requireSignature') === 'on',
        requireConfirmAtClose: data.get('requireConfirmAtClose') === 'on',
        requireApproval: data.get('requireApproval') === 'on',
        adminPin: String(data.get('adminPin') || '').trim(),
      };
      if (!session) {
        const rakeMode = data.get('rakeMode');
        const rakeRaw = parseFloat(String(data.get('rakeValue') ?? '0').replace(',', '.')) || 0;
        Object.assign(patch, {
          buyValue: toCents(data.get('buyValue')),
          chipsPerBuy: Math.max(1, parseInt(data.get('chipsPerBuy'), 10) || 1),
          rakeMode,
          rakeValue: { perBuy: Math.max(0, Math.round(rakeRaw)), percent: Math.min(100, Math.max(0, rakeRaw)), fixed: toCents(rakeRaw), none: 0 }[rakeMode],
          paymentMode: data.get('paymentMode'),
        });
        if (patch.buyValue <= 0) return toast('O valor do buy precisa ser maior que zero', { type: 'error' });
        if (rakeMode === 'perBuy' && patch.rakeValue >= patch.chipsPerBuy) return toast('O rake precisa ser menor que as fichas do buy', { type: 'error' });
      }
      if (patch.adminPin) adminUnlockedUntil = Date.now() + 10 * 60 * 1000;
      S.updateSettings(patch);
      toast('Configurações salvas');
      return;
    }
    default:
  }
});

app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.name && t.closest('[data-form]')) t.dataset.dirty = '1';
  const countId = t.dataset.count;
  if (!countId || t.readOnly) return;
  const digits = t.value.replace(/\D/g, '');
  t.value = digits;
  // A mudança de contagem desmarca o "Conferido" daquele jogador (feito no store).
  S.setCount(countId, digits === '' ? null : parseInt(digits, 10));
});

app.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.confirm) {
    const { draft } = S.getState().session;
    if (t.checked && draft.counts[t.dataset.confirm] == null) {
      t.checked = false;
      return toast('Digite as fichas antes de conferir', { type: 'error' });
    }
    S.setConfirmed(t.dataset.confirm, t.checked);
  } else if (t.name === 'rakeMode') {
    // Re-renderiza para trocar a unidade do rake, mantendo o que foi digitado.
    t.dataset.dirty = '1';
    const rake = app.querySelector('[name="rakeValue"]');
    if (rake) rake.value = t.value === 'fixed' ? '0.00' : '0';
    rake?.closest('label')?.toggleAttribute('hidden', t.value === 'none');
    const unit = rake?.closest('label')?.querySelector('.muted');
    if (rake) rake.step = { percent: '0.1', fixed: '0.01' }[t.value] || '1';
    if (unit) unit.textContent = { perBuy: '(fichas por buy)', percent: '(% do pote)', fixed: '(R$ na noite)' }[t.value] || '';
  } else if (t.matches('[data-import]') && t.files[0]) {
    const text = await t.files[0].text();
    if (await confirmDialog('Importar backup?', 'Os dados atuais serão substituídos pelos do arquivo.', { confirmText: 'Importar', danger: true })) {
      try {
        await S.importData(text);
        toast('Backup importado');
      } catch (err) {
        toast(err.message, { type: 'error', timeout: 7000 });
      }
    }
    t.value = '';
  }
});

// ---------- Conexão, tela ligada e versão ----------
/** Faixa no topo: sem conexão, lançamentos guardados no aparelho ou descartados. */
function renderNetbar() {
  const s = S.syncInfo();
  let html = '';
  let tone = 'warn';
  if (s.dropped) {
    tone = 'error';
    html = `<span>${plural(s.dropped, 'lançamento não foi enviado', 'lançamentos não foram enviados')}: a jogatina já tinha sido encerrada ou descartada em outro celular.</span><button type="button" data-net-ok>OK</button>`;
  } else if (s.mode === 'offline' || s.mode === 'error') {
    tone = s.mode === 'error' ? 'error' : 'warn';
    const what = s.mode === 'error' ? `Erro de conexão${s.error ? ` (${esc(s.error)})` : ''}.` : 'Sem conexão.';
    html = `<span><strong>${what}</strong> ${s.pending ? `${plural(s.pending, 'lançamento guardado', 'lançamentos guardados')} neste celular — vão ser enviados quando a internet voltar.` : 'O que você lançar fica guardado e é enviado quando a internet voltar.'}</span>`;
  } else if (s.pending && s.mode === 'online') {
    tone = 'info';
    html = `<span>Enviando ${plural(s.pending, 'lançamento', 'lançamentos')}…</span>`;
  }
  netbar.hidden = !html;
  netbar.className = `netbar ${tone}`;
  netbar.innerHTML = html;
  netbar.querySelector('[data-net-ok]')?.addEventListener('click', () => S.clearDropped());
}
S.subscribe(renderNetbar);

// Avisa antes de fechar/recarregar com lançamentos ainda não enviados.
window.addEventListener('beforeunload', (e) => {
  if (S.syncInfo().pending) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Mantém a tela ligada enquanto houver jogatina aberta.
let wakeLock = null;
let wakeBusy = false;
async function keepAwake() {
  const want = Boolean(S.getState().session) && document.visibilityState === 'visible';
  if (wakeBusy || !('wakeLock' in navigator)) return;
  wakeBusy = true;
  try {
    if (want && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null; // o navegador pode recusar (economia de bateria etc.)
  } finally {
    wakeBusy = false;
  }
}
S.subscribe(keepAwake);

// Avisa quando sai uma versão nova do app e atualiza todos os arquivos de uma vez.
const APP_FILES = ['./', 'index.html', 'manifest.webmanifest', 'css/styles.css', 'js/app.js', 'js/store.js', 'js/calc.js', 'js/sync.js', 'js/signature.js', 'js/firebase-config.js', 'js/version.js'];
const updatebar = document.getElementById('updatebar');
async function checkVersion() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = await r.json();
    updatebar.hidden = !version || version === APP_VERSION;
  } catch {
    /* sem internet: tenta de novo depois */
  }
}
updatebar.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-update]')) return;
  e.target.disabled = true;
  e.target.textContent = 'Atualizando…';
  await Promise.all(APP_FILES.map((f) => fetch(f, { cache: 'reload' }).catch(() => null)));
  location.reload();
});
setInterval(checkVersion, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  keepAwake();
  if (document.visibilityState === 'visible') checkVersion();
});

render();
renderNetbar();
keepAwake();
checkVersion();
handleInviteLink();
