# ♠ Poker Night

Controle das noites de poker com os amigos: buys por jogador, pote sempre visível, fechamento com conferência de fichas e acertos via Pix. Funciona no celular e no computador, sem instalar nada.

**Abrir o app:** https://ticoooe.github.io/poker-night/

## Como usar

1. **Mesa → Nova jogatina:** adicione quem vai jogar (os frequentes aparecem com um toque) e toque em *Começar jogatina*.
2. **+ Buy:** o jogador **assina com o dedo** na tela e confirma. O pote, o número de buys e as fichas em jogo atualizam na hora, no topo da tela.
3. Errou? Um toque em **Desfazer** logo após o registro, ou toque no nome do jogador → *Anular* (pede motivo e, se configurado, PIN).
4. **Finalizar jogatina:** conte as fichas de cada um, digite, e o jogador marca *Conferido*. Só dá para encerrar quando **a soma bate exatamente** com as fichas em jogo.
5. **Resultado:** quanto cada um recebe, o saldo e a lista mínima de Pix. Botão para compartilhar no grupo do WhatsApp.

**Admin (⚙︎):** nome do grupo, valor do buy, fichas por buy, rake (por buy, % do pote ou fixo), forma de pagamento, PIN do admin, backup.

> Dica: no celular, use "Adicionar à tela de início" para abrir como app.

## Como o app evita "quebra" de valores

| Problema de antes | Como o app resolve |
|---|---|
| Ficha colorida de controle se perdia | O buy existe **só no app**, com data/hora e assinatura do jogador. Nada físico para perder. |
| "Eu não fiz 3 buys, foram 2" | Cada buy tem a **assinatura** de quem pegou as fichas. Em *Ver assinaturas* dá para conferir um por um. |
| Buy lançado errado ou em dobro | Buys **nunca são apagados**: são *anulados* com motivo e continuam no registro, riscados. Proteção contra toque duplo. |
| Conta que não fecha no final | O fechamento exige que **fichas contadas = fichas vendidas**. Se faltar ou sobrar uma ficha, o app mostra a diferença e não deixa encerrar. |
| Centavos que somem na divisão | Todo cálculo é feito em **centavos inteiros** e a divisão usa o método do maior resto: a soma dos pagamentos é *exatamente* o prêmio. Coberto por testes (`npm test`). |
| Alguém alterar o valor no meio do jogo | Valor do buy, fichas e rake ficam **travados** enquanto há jogatina aberta. Admin protegido por PIN. |
| Contagem alterada depois de conferida | Se alguém muda a contagem de um jogador, o "Conferido" dele é desmarcado automaticamente. |

### Combinados sugeridos para a mesa

- **Um "banqueiro" por noite:** só ele entrega fichas, e só depois do buy assinado no app. Sem assinatura, sem ficha.
- **Fichas pré-montadas:** deixe pilhas prontas do valor exato de um buy (ex.: 1.000). Entrega mais rápida e sem erro de troco.
- **Conte as fichas iniciais:** antes de começar, confira que o total de fichas da maleta é conhecido. Assim, no fim, "fichas em jogo + fichas na maleta = total da maleta".
- **Fechamento em voz alta:** cada jogador conta as próprias fichas na frente de todos e marca *Conferido* no app.
- **Pix antes de ir embora:** use a lista de acertos do resultado; ela já vem com o menor número de transferências.
- **Backup mensal:** Admin → *Exportar backup* e mande o arquivo no grupo.

## Detalhes técnicos

- HTML + CSS + JavaScript puro (ES modules), sem build. Hospedado no GitHub Pages.
- Dados salvos no `localStorage` do aparelho que controla a mesa (use sempre o mesmo celular/tablet como "caixa"). Backup/importação em JSON pelo Admin.
- `js/calc.js` — cálculos puros (pote, rake, divisão, acertos) · `js/store.js` — estado e persistência · `js/app.js` — interface · `js/signature.js` — campo de assinatura.

### Rodar localmente

```bash
npm start   # abre em http://localhost:5391
npm test    # testes dos cálculos
```

### Próximos passos possíveis

- Sincronizar entre vários celulares em tempo real (ex.: Supabase/Firebase), para cada jogador acompanhar do próprio aparelho.
- Ranking/estatísticas acumuladas por jogador ao longo das noites.
- Confirmação do buy por PIN pessoal de cada jogador, como alternativa à assinatura.
