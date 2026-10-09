// Gera um número de versão novo antes de publicar. Os celulares com a versão antiga
// mostram "Saiu uma versão nova do app" e atualizam todos os arquivos de uma vez.
import { writeFileSync } from 'node:fs';

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const version = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
writeFileSync(new URL('../js/version.js', import.meta.url), `// Gerado por \`npm run release\`. Não edite à mão.\nexport const APP_VERSION = '${version}';\n`);
writeFileSync(new URL('../version.json', import.meta.url), `${JSON.stringify({ version })}\n`);
console.log(`versão ${version}`);
