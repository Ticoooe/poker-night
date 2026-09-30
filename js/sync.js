// Sincronização online via Firebase Realtime Database (SDK carregado sob demanda).
const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

/**
 * Conecta ao grupo `code`. `handlers.onData(chave, valor)` é chamado sempre que
 * settings / session / history mudam em qualquer aparelho.
 */
export async function connect(config, code, handlers = {}) {
  const [{ initializeApp, getApps }, db] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-database.js`),
  ]);
  const app = getApps()[0] || initializeApp(config);
  const database = db.getDatabase(app);
  const root = `groups/${code}`;
  const ref = (path) => db.ref(database, path ? `${root}/${path}` : root);

  const unsubs = [];
  if (handlers.onStatus) {
    unsubs.push(db.onValue(db.ref(database, '.info/connected'), (s) => handlers.onStatus(s.val() ? 'online' : 'offline')));
  }
  if (handlers.onData) {
    for (const key of ['settings', 'session', 'history']) {
      unsubs.push(db.onValue(ref(key), (s) => handlers.onData(key, s.val()), (err) => handlers.onError?.(err)));
    }
  }

  return {
    code,
    /** Escrita multi-caminho atômica: { 'session/ledger/abc': {...}, 'signatures/x/abc': '...' } */
    update: (updates) => db.update(ref(), updates),
    set: (value) => db.set(ref(), value),
    get: async (path) => (await db.get(ref(path))).val(),
    close: () => unsubs.forEach((u) => u()),
  };
}
