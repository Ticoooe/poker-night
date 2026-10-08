# Poker das Uvas 🍇

App web (HTML/CSS/JS puro, sem build) + Firebase Realtime Database, publicado no GitHub Pages a partir da branch `main` (cada push em `main` vai ao ar em ~1 min, para todos os celulares do grupo).

- Valores sempre em centavos inteiros (`js/calc.js`). Regra do grupo: buy R$ 30 = 60 fichas, 5 de rake → 55 em jogo.
- Toda escrita passa por `apply(updates)` em `js/store.js` (multi-path, com fila persistente). Começar/encerrar/descartar jogatina usam transação no servidor.
- Antes de publicar: `npm test` e `npm run release` (atualiza `js/version.js` e `version.json`, que disparam o aviso de versão nova).
- Não publicar em `main` durante uma jogatina aberta do grupo; confira `groups/<código>/session` antes.
