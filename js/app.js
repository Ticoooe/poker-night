import * as S from './store.js';
import { SignaturePad } from './signature.js';

const app = document.getElementById('app');
const dlg = document.getElementById('modal');
const toastEl = document.getElementById('toast');
const syncEl = document.getElementById('sync');

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
  if (!pin || Date.now() < adminUnlockedUntil) return true;
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
    <button class="btn primary big block" data-action="start" ${pendingNames.length < 2 ? 'disabled' : ''}>Começar jogatina</button>`;
}

function viewMesa() {
  const { session, settings } = S.getState();
  if (!session) return viewStart();
  const inTable = new Set(session.players.map((p) => p.name.toLowerCase()));
  const frequent = S.frequentPlayers().filter((n) => !inTable.has(n.toLowerCase()));
  const recent = [...session.ledger].filter((e) => e.type === 'buy' || e.type === 'void').reverse().slice(0, 6);
  const nameOf = (id) => session.players.find((p) => p.id === id)?.name ?? '—';

  return `
    ${summaryBar()}
    <p class="session-meta">Começou ${hour(session.startedAt)} · ${termsLine(settings)}</p>
    <section class="players">
      ${session.players.map((p) => {
        const st = S.playerStats(p.id);
        return `
        <article class="player">
          <button class="player-info" data-action="player" data-id="${p.id}" aria-label="Detalhes de ${esc(p.name)}">
            <span class="avatar">${esc(initial(p.name))}</span>
            <span class="pname"><strong>${esc(p.name)}</strong><small>${money(st.paid)}</small></span>
          </button>
          <div class="buycount" title="Buys">${chipsPips(st.buys)}<strong>${st.buys}</strong><small>${st.buys === 1 ? 'buy' : 'buys'}</small></div>
          <button class="btn-buy" data-action="buy" data-id="${p.id}">+ Buy</button>
        </article>`;
      }).join('') || '<p class="muted">Nenhum jogador ainda.</p>'}
    </section>
    <section class="card">
      <form class="inline-form" data-form="player-add">
        <input class="field" name="name" placeholder="Adicionar jogador" autocomplete="off" enterkeyhint="done" />
        <button class="btn">Adicionar</button>
      </form>
      ${frequent.length ? `<div class="chips">${frequent.map((n) => `<button class="chip" data-action="player-quick" data-name="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}
    </section>
    <a class="btn primary big block" href="#/fechar">Finalizar jogatina</a>
    ${recent.length ? `
    <section class="card">
      <h2>Últimos registros</h2>
      <ul class="log">${recent.map((e) => e.type === 'buy'
        ? `<li class="${e.voided ? 'voided' : ''}"><time>${hour(e.at)}</time> <span>${e.voided ? 'Buy' : `Buy #${e.seq}`} · <strong>${esc(nameOf(e.playerId))}</strong></span> <span>${money(e.value)}</span></li>`
        : `<li class="void"><time>${hour(e.at)}</time> <span>Anulado · <strong>${esc(nameOf(e.playerId))}</strong> — ${esc(e.reason)}</span></li>`).join('')}
      </ul>
    </section>` : ''}`;
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
        return `
        <article class="close-row" data-row="${p.id}">
          <div class="close-name"><span class="avatar sm">${esc(initial(p.name))}</span>
            <span><strong>${esc(p.name)}</strong><small>${plural(st.buys, 'buy', 'buys')} · pagou ${money(st.paid)}</small></span></div>
          <label class="count"><span>Fichas</span>
            <input class="field" data-count="${p.id}" inputmode="numeric" pattern="[0-9]*" placeholder="—" value="${c ?? ''}" />
          </label>
          <div class="close-result"><small>Recebe</small><strong data-payout>—</strong><small data-net></small></div>
          ${settings.requireConfirmAtClose ? `<label class="confirm"><input type="checkbox" data-confirm="${p.id}" ${draft.confirmed[p.id] ? 'checked' : ''}/> Conferido</label>` : ''}
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
  const unconfirmed = settings.requireConfirmAtClose ? session.players.filter((p) => !draft.confirmed[p.id]).length : 0;
  const pct = expected ? Math.min(100, (r.counted / expected) * 100) : 0;
  const bar = app.querySelector('[data-progress]');
  bar.style.width = `${pct}%`;
  bar.className = r.diff > 0 ? 'over' : r.diff === 0 && expected ? 'ok' : '';

  let status;
  if (!session.players.length) status = 'Nenhum jogador na mesa.';
  else if (missing) status = `Contadas <strong>${num(r.counted)}</strong> de <strong>${num(expected)}</strong> fichas · falta contar ${plural(missing, 'jogador', 'jogadores')}.`;
  else if (r.diff < 0) status = `⚠️ Faltam <strong>${num(-r.diff)}</strong> fichas (${num(r.counted)} de ${num(expected)}). Reconte antes de fechar.`;
  else if (r.diff > 0) status = `⚠️ Sobram <strong>${num(r.diff)}</strong> fichas (${num(r.counted)} de ${num(expected)}). Tem ficha a mais na mesa ou buy sem registro.`;
  else if (unconfirmed) status = `✅ Contagem bate! Falta ${plural(unconfirmed, 'jogador', 'jogadores')} marcar “Conferido”.`;
  else status = `✅ Tudo certo: ${num(expected)} fichas conferidas. Prêmio de ${money(r.totals.prize)}.`;
  app.querySelector('[data-status]').innerHTML = status;

  app.querySelector('[data-action="close-session"]').disabled = !(session.players.length && !missing && r.diff === 0 && !unconfirmed);
}

function viewResultado(id) {
  const s = S.getHistorySession(id);
  if (!s) return `<section class="card"><p>Jogatina não encontrada.</p><a class="btn" href="#/historico">Voltar</a></section>`;
  const r = s.result;
  const cfg = s.settingsAtClose || {};
  const rows = [...r.rows].sort((a, b) => b.net - a.net);
  const caixa = cfg.paymentMode === 'caixa';
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
        <tbody>${rows.map((x) => `<tr><td><strong>${esc(x.name)}</strong></td><td>${x.buys}</td><td class="hide-xs">${money(x.paid)}</td><td class="hide-xs">${num(x.chips)}</td><td>${money(x.payout)}</td><td class="${netClass(x.net)}"><strong>${signed(x.net)}</strong></td></tr>`).join('')}</tbody>
      </table></div>
    </section>
    <section class="card">
      ${caixa
        ? `<h2>Pagamentos do caixa</h2><p class="muted small">Os buys foram pagos na hora. O caixa paga:</p>
           <ul class="transfers">${rows.filter((x) => x.payout > 0).map((x) => `<li><span>Caixa → <strong>${esc(x.name)}</strong></span><strong>${money(x.payout)}</strong></li>`).join('')}
           ${r.totals.rake ? `<li><span>Caixa → <strong>Casa (rake)</strong></span><strong>${money(r.totals.rake)}</strong></li>` : ''}</ul>`
        : `<h2>Acertos (Pix)</h2><p class="muted small">Menor número de transferências para zerar tudo:</p>
           <ul class="transfers">${r.transfers.map((t) => `<li><span><strong>${esc(t.from)}</strong> → <strong>${esc(t.to)}</strong></span><strong>${money(t.amount)}</strong></li>`).join('') || '<li>Ninguém deve nada 🎉</li>'}</ul>`}
    </section>
    <div class="row wrap">
      <button class="btn primary" data-action="share" data-id="${s.id}">Compartilhar resumo</button>
      <button class="btn" data-action="audit" data-id="${s.id}">Ver assinaturas</button>
      <a class="btn ghost" href="#/historico">Histórico</a>
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

function viewHistorico() {
  const { history } = S.getState();
  if (!history.length) return `<section class="hero"><h1>Histórico</h1><p class="muted">Nenhuma jogatina encerrada ainda.</p></section>`;
  return `
    <section class="hero small"><h1>Histórico</h1><p class="muted">${plural(history.length, 'jogatina', 'jogatinas')}</p></section>
    <section class="history">
      ${history.map((s) => {
        const best = [...s.result.rows].sort((a, b) => b.net - a.net)[0];
        return `<a class="history-item" href="#/resultado/${s.id}">
          <span><strong>${day(s.startedAt)}</strong><small>${plural(s.players.length, 'jogador', 'jogadores')} · ${plural(s.result.totals.count, 'buy', 'buys')}</small></span>
          <span class="right"><strong>${money(s.result.totals.pot)}</strong>${best && best.net > 0 ? `<small>🏆 ${esc(best.name)} ${signed(best.net)}</small>` : ''}</span>
        </a>`;
      }).join('')}
    </section>`;
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
  if (settings.adminPin && Date.now() >= adminUnlockedUntil && !adminGateOpen) {
    return `<section class="hero"><h1>Admin</h1><p class="muted">Área protegida por PIN.</p>
      <button class="btn primary big" data-action="admin-unlock">Desbloquear</button></section>`;
  }
  const locked = Boolean(session);
  const dis = locked ? 'disabled' : '';
  const t = S.buyTerms(settings);
  const rakeField = { perBuy: ['(fichas por buy)', settings.rakeValue, '1'], percent: ['(% do pote)', settings.rakeValue, '0.1'], fixed: ['(R$ na noite)', (settings.rakeValue / 100).toFixed(2), '0.01'], none: ['', 0, '1'] }[settings.rakeMode];
  return `
    <section class="hero small"><h1>Admin</h1><p class="muted">Configurações do grupo</p></section>
    ${syncSection()}
    <form class="card form" data-form="settings">
      <h2>Grupo</h2>
      <label>Nome do grupo<input class="field" name="groupName" value="${esc(settings.groupName)}" maxlength="40" /></label>
      <label><span>Jogadores frequentes <small class="muted">— um por linha</small></span>
        <textarea class="field" name="regulars" rows="6">${esc((settings.regulars || []).join('\n'))}</textarea></label>

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
      <label class="switch"><input type="checkbox" name="requireConfirmAtClose" ${settings.requireConfirmAtClose ? 'checked' : ''} /> Cada jogador marca “Conferido” no fechamento</label>

      <h2>Segurança</h2>
      <label><span>PIN do admin <small class="muted">— protege esta página, anulação de buys e exclusões (vazio = sem PIN)</small></span>
        <input class="field" name="adminPin" type="password" inputmode="numeric" autocomplete="new-password" value="${esc(settings.adminPin)}" maxlength="8" /></label>

      <button class="btn primary big block">Salvar configurações</button>
    </form>

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
        <button class="btn danger" data-action="clear-history" ${history.length ? '' : 'disabled'}>Apagar histórico</button>
      </div>
    </section>`;
}

// ---------- Modais de jogador / buy ----------
function openBuy(playerId) {
  const { settings } = S.getState();
  const p = S.getPlayer(playerId);
  if (!p) return;
  const t = S.buyTerms(settings);
  const n = S.playerStats(playerId).buys + 1;
  const needSig = settings.requireSignature;
  openModal(
    `<header><h2>Buy #${n} · ${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
     <div class="buy-amount"><strong>${money(t.value)}</strong><span>${num(t.chips)} fichas${t.rakeChips ? `<small>+ ${t.rakeChips} de rake</small>` : ''}</span></div>
     ${needSig
       ? `<p class="hint"><strong>${esc(p.name)}</strong>, assine abaixo para confirmar que recebeu as fichas.</p>
          <div class="sigwrap"><canvas class="sig"></canvas><span class="sig-ph">assine aqui</span>
          <button type="button" class="link" data-clear>Limpar</button></div>`
       : `<p class="hint">Confirme que <strong>${esc(p.name)}</strong> recebeu ${num(t.chips)} fichas.</p>`}
     <footer><button type="button" class="btn ghost" data-close>Cancelar</button>
       <button type="button" class="btn primary" data-ok ${needSig ? 'disabled' : ''}>Confirmar buy</button></footer>`,
    (root) => {
      const ok = root.querySelector('[data-ok]');
      let pad;
      if (needSig) {
        const ph = root.querySelector('.sig-ph');
        pad = new SignaturePad(root.querySelector('canvas'), {
          onChange: (empty) => { ok.disabled = empty; ph.hidden = true; },
        });
        root.querySelector('[data-clear]').addEventListener('click', () => { pad.clear(); ph.hidden = false; });
      }
      ok.addEventListener('click', () => {
        ok.disabled = true; // evita toque duplo
        const entry = attempt(() => S.addBuy(playerId, pad ? pad.toDataURL() : null));
        if (!entry) { ok.disabled = false; return; }
        closeModal();
        toast(`Buy #${entry.seq} de ${p.name} registrado`, {
          action: 'Desfazer',
          timeout: 7000,
          onAction: () => { S.voidBuy(entry.id, 'Desfeito logo após o registro'); toast('Buy desfeito'); },
        });
      });
    },
  );
}

function openPlayer(playerId) {
  const { session } = S.getState();
  const p = S.getPlayer(playerId);
  if (!p) return;
  const st = S.playerStats(playerId);
  const entries = session.ledger.filter((e) => e.type === 'buy' && e.playerId === playerId);
  openModal(
    `<header><h2>${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
     <p class="muted">${plural(st.buys, 'buy válido', 'buys válidos')} · ${money(st.paid)}</p>
     <ul class="entries">
       ${entries.map((e) => `<li class="${e.voided ? 'voided' : ''}">
          <div><strong>${e.voided ? 'Buy anulado' : `Buy #${e.seq}`}</strong><small>${hour(e.at)} · ${money(e.value)}</small>
            ${e.voided ? `<small class="neg">Motivo: ${esc(e.voided.reason)}</small>` : ''}</div>
          ${sigImg(e)}
          ${e.voided ? '' : `<button class="btn small ghost" data-void="${e.id}">Anular</button>`}
        </li>`).join('') || '<li class="muted">Nenhum buy ainda.</li>'}
     </ul>
     <footer>
       <button type="button" class="btn ghost" data-rename>Renomear</button>
       <button type="button" class="btn danger" data-remove ${st.buys ? 'disabled title="Anule os buys antes"' : ''}>Remover da mesa</button>
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
      root.querySelector('[data-rename]').addEventListener('click', async () => {
        const name = await ask({ title: 'Renomear', input: `value="${esc(p.name)}" maxlength="30"`, confirmText: 'Salvar' });
        if (name) attempt(() => S.renamePlayer(playerId, name));
        openPlayer(playerId);
      });
      root.querySelector('[data-remove]').addEventListener('click', async () => {
        if (await confirmDialog('Remover jogador?', `${esc(p.name)} sai da mesa.`, { confirmText: 'Remover', danger: true })) {
          attempt(() => S.removePlayer(playerId));
        }
      });
    },
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
    .map((el) => ({ sel: `[data-form="${el.form.dataset.form}"] [name="${el.name}"]`, value: el.type === 'checkbox' ? el.checked : el.value, focused: el === document.activeElement }));
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
  document.getElementById('brand-name').textContent = settings.groupName || 'Poker Night';
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === name || (a.dataset.nav === 'historico' && name === 'resultado') || (a.dataset.nav === 'mesa' && name === 'fechar');
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
  const views = { mesa: viewMesa, fechar: viewFechar, resultado: () => viewResultado(arg), historico: viewHistorico, admin: viewAdmin };
  app.innerHTML = (views[name] || viewMesa)();
  app.dataset.view = name;
  restoreInputs(saved);
  if (name === 'fechar' && session) updateFechar();
}

window.addEventListener('hashchange', () => { adminGateOpen = false; renderedKey = ''; app.innerHTML = ''; render(); window.scrollTo(0, 0); });
S.subscribe(render);

// ---------- Eventos ----------
const guarded = new Set(['cancel-session', 'clear-history', 'group-leave']);
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
      attempt(() => S.startSession(pendingNames));
      if (S.getState().session) pendingNames = [];
      return render();
    case 'close-session': {
      const r = S.settlement(S.getState().session.draft.counts);
      const ok = await confirmDialog('Encerrar jogatina?', `Pote de <strong>${money(r.totals.pot)}</strong>, ${num(r.totals.chips)} fichas conferidas. Depois de encerrar, não dá mais para lançar buys.`, { confirmText: 'Encerrar' });
      if (!ok) return;
      const sid = attempt(() => S.closeSession());
      if (sid) location.hash = `#/resultado/${sid}`;
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
        S.cancelSession();
        toast('Jogatina descartada');
      }
      return;
    case 'clear-history':
      if (await confirmDialog('Apagar histórico?', 'Todas as jogatinas encerradas serão apagadas. Exporte um backup antes.', { confirmText: 'Apagar tudo', danger: true })) {
        S.clearHistory();
        toast('Histórico apagado');
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
      const n = String(data.get('name') || '').trim().replace(/\s+/g, ' ');
      if (!n) return;
      if (pendingNames.some((x) => x.toLowerCase() === n.toLowerCase())) return toast(`"${n}" já está na lista`, { type: 'error' });
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
      const patch = {
        groupName: String(data.get('groupName') || '').trim() || 'Poker Night',
        regulars: String(data.get('regulars') || '').split(/[\n,]/).map((n) => n.trim().replace(/\s+/g, ' ')).filter(Boolean),
        requireSignature: data.get('requireSignature') === 'on',
        requireConfirmAtClose: data.get('requireConfirmAtClose') === 'on',
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
  if (!countId) return;
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
      attempt(() => { S.importData(text); toast('Backup importado'); });
    }
    t.value = '';
  }
});

render();
handleInviteLink();
