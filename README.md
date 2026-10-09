# ♠ Poker das Uvas 🍇

Controle das noites de poker com os amigos: buys por jogador, pote sempre visível, fechamento com conferência de fichas e acertos via Pix. Funciona no celular e no computador, sem instalar nada.

**Abrir o app:** https://ticoooe.github.io/poker-night/

## Como usar

1. **Mesa → Nova jogatina:** adicione quem vai jogar (os frequentes aparecem com um toque) e toque em *Começar jogatina*.
2. **+ Buy:** escolha **quantos buys** (1 a 10) — o app mostra o total e **quantas assinaturas** serão necessárias. O jogador **assina uma vez para cada buy** ("Assinatura 2 de 3") e tudo vai como **um pedido só** para o admin. O pote, o número de buys e as fichas em jogo atualizam na hora, no topo da tela.
3. **Aprovação do admin:** o buy fica **⏳ aguardando aprovação** e só entra no pote depois que o admin aprova (vendo a assinatura). O pedido aparece em destaque na mesa e no Admin, em todos os celulares — com todas as assinaturas juntas e os botões **Aprovar N buys** / **Recusar tudo**. No **aparelho do admin** (Admin → *Usar este aparelho como admin*) chega um aviso com vibração a cada pedido novo, e aprovar/recusar não pede PIN; em outro aparelho, aprovar pede o PIN. Buy lançado no próprio aparelho do admin já sai aprovado ("Confirmar e aprovar"). Recusados ficam no registro com o motivo. Não dá para fechar a jogatina com pedido pendente. Dá para desligar em Admin → Conferência.
4. Errou? Um toque em **Desfazer** logo após o registro, ou toque no nome do jogador → *Anular* (pede motivo e, se configurado, PIN).
5. **Alguém vai embora antes?** Toque no nome dele → **🏁 Encerrar jogo de Fulano**. Conte as fichas dele, o app mostra na hora quanto ele recebe e o saldo; ele confere e o admin confirma. A contagem fica **travada** (não dá para lançar mais buys nem mudar as fichas dele) e entra sozinha no fechamento. Na mesa ele aparece em **Já saíram**, e o botão **Avisar o caixa** manda no WhatsApp o "A pagar / A receber" só dele. Errou? *Desfazer saída* (pede o PIN).
6. **Finalizar jogatina:** conte as fichas de cada um, digite, e o jogador marca *Conferido*. Só dá para encerrar quando **a soma bate exatamente** com as fichas em jogo.
7. **Resultado:** quanto cada um recebe e o saldo. O botão **Enviar para o caixa (WhatsApp)** abre a conversa com o caixa já com a mensagem pronta:
   ```
   A pagar:
   Ian - R$ 60,00 - Pix do caixa: caixa@email.com
   A receber:
   Tico - R$ 45,00 - Pix: tico@email.com
   Davi - R$ 5,00 - Pix: davi@email.com
   Rake (fica no caixa): R$ 10,00
   ```
8. **Histórico → Partidas:** as partidas encerradas, agrupadas por mês, com o campeão de cada mês (ou quem está liderando o mês atual).
9. **Histórico → Ranking:** ranking **geral** e de **cada mês**, com ganhos (soma das noites no positivo), perdas (soma das noites no negativo), saldo, jogos e vitórias. Botão para compartilhar no grupo.
10. **Acertos:** no resultado, cada pessoa tem um botão **Marcar pago / Marcar recebido**. Enquanto houver Pix pendente, aparece o aviso **💸 Acertos pendentes** na mesa e no Histórico.
11. **Lixeira:** apagar uma partida manda para a **lixeira** (no fim do Histórico), de onde dá para restaurar. Só *Excluir de vez* ou *Esvaziar lixeira* apagam para sempre (pedem o PIN).

**Admin (⚙︎):** nome do grupo, jogadores frequentes, caixa (nome, WhatsApp e chave Pix), chaves Pix dos jogadores, valor do buy, fichas por buy, rake (fichas por buy, % do pote ou fixo), forma de pagamento, PIN do admin, sincronização online e backup.

### Regras atuais do grupo

- **Buy:** R$ 30,00 = 60 fichas (1 ficha = R$ 0,50)
- **Rake:** 5 fichas por buy (R$ 2,50) → **55 fichas entram em jogo** por buy
- No fechamento, o total contado precisa ser `55 × número de buys`.
- **Frequentes:** Tico, Ian, Giovanni, Davi, Marlon, Titã, Maciel, Nikin, Jota, Kevin, Felipin

## Sincronização online (vários celulares)

Com a sincronização ligada, todos os celulares do grupo veem a mesma mesa em tempo real: qualquer um pode lançar buys, e a contagem do fechamento aparece para todos. O ponto no topo mostra o status (🟢 online · 🟠 sem conexão · ⚪ só neste aparelho).

Cada buy é gravado como um registro separado, então dois celulares lançando ao mesmo tempo **nunca sobrescrevem** um ao outro.

- **Sem internet:** aparece uma faixa laranja **Sem conexão**. O que for lançado fica guardado no celular (mesmo se a página recarregar) e é enviado quando a internet voltar. Lançamentos de uma jogatina que já foi encerrada em outro celular não são reenviados, e o app avisa.
- **Começar, encerrar e descartar** só funcionam online e são conferidos no servidor: um celular desatualizado não consegue apagar a mesa de outro nem encerrar com números diferentes dos do servidor.
- **Tela ligada:** com jogatina aberta, o app pede para o celular não apagar a tela.
- **Versão nova:** quando o app é atualizado, aparece **Saiu uma versão nova do app → Atualizar agora**.

O Firebase do grupo (`poker-night-aeed6`) já está configurado em [`js/firebase-config.js`](js/firebase-config.js). Para começar: no celular do caixa, **Admin → Criar grupo online → Compartilhar link do grupo**.

### Configuração do zero (caso precise recriar o Firebase)

1. Acesse https://console.firebase.google.com e crie um projeto (ex.: `poker-night`). Pode desativar o Google Analytics.
2. No menu **Criação → Realtime Database → Criar banco de dados**. Escolha a localização (Estados Unidos) e **modo bloqueado**.
3. Na aba **Regras**, cole o conteúdo de [`database.rules.json`](database.rules.json) e clique em **Publicar**.
4. Em **⚙︎ Configurações do projeto → Seus apps**, clique no ícone **Web `</>`**, registre o app (sem Hosting) e copie o objeto `firebaseConfig`. Confira que ele tem `databaseURL` (se não tiver, copie a URL que aparece no topo da página do Realtime Database e adicione).
5. Salve o `firebaseConfig` em [`js/firebase-config.js`](js/firebase-config.js) (ou cole em **Admin → Sincronização → Configurar Firebase**).
6. No celular do "caixa": **Admin → Criar grupo online**. Os dados atuais sobem para o grupo.
7. **Compartilhar link do grupo** → mande no WhatsApp. Quem abrir o link entra no grupo.

> Segurança: o banco só aceita leitura/escrita dentro de `groups/<código>`, e o código é aleatório (10 caracteres). Quem não tem o link não acessa. Use o PIN do admin para proteger anulações e configurações.

> Dica: no celular, use "Adicionar à tela de início" para abrir como app.

## Como o app evita "quebra" de valores

| Problema de antes | Como o app resolve |
|---|---|
| Ficha colorida de controle se perdia | O buy existe **só no app**, com data/hora e assinatura do jogador. Nada físico para perder. |
| Buy lançado sem o admin ver | Todo buy precisa ser **aprovado pelo admin** antes de entrar no pote. |
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
- Sem grupo online, os dados ficam no `localStorage` do aparelho. Com grupo, ficam no Firebase Realtime Database (com cache local). Backup/importação em JSON pelo Admin.
- `js/calc.js` — cálculos puros (pote, rake, divisão, acertos) · `js/store.js` — estado, escrita granular e sincronização · `js/sync.js` — conexão com o Firebase · `js/app.js` — interface · `js/signature.js` — campo de assinatura.

### Rodar localmente

```bash
npm start   # abre em http://localhost:5391
npm test    # testes dos cálculos e do fluxo da mesa
```

### Publicar

```bash
npm test
npm run release   # gera um número de versão novo (aviso de atualização nos celulares)
git commit -am "…" && git push   # o GitHub Pages publica em ~1 minuto
```

Evite publicar no meio de uma jogatina.

### Próximos passos possíveis

- Confirmação do buy por PIN pessoal de cada jogador, como alternativa à assinatura.
