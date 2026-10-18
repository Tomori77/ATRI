import { readFileSync } from 'node:fs';
const server = readFileSync('apps/api/src/server.ts', 'utf8');
// The generic <...> CAN contain ';' (e.g. { Params: { id: string }; Body: ... }),
// so the inline pattern must allow ';' inside <>. Use a balanced brace match
// instead: app.<verb> then optional < ... > (counting <>), then (, then quote.
const routes = new Set();
const lines = server.split('\n');
let pendingVerb = null;
for (const line of lines) {
  const inline = line.match(/app\.(get|post|put|delete)\s*(<[\s\S]*?>)?\s*\(\s*'([^']+)'/);
  if (inline) {
    routes.add(inline[1].toUpperCase() + ' ' + inline[3]);
    pendingVerb = null;
    continue;
  }
  const open = line.match(/app\.(get|post|put|delete)\s*(<[\s\S]*?>)?\s*\(\s*$/);
  if (open) {
    pendingVerb = open[1];
    continue;
  }
  const p = line.match(/^\s*'((?:\/api|\/healthz)[^']*)'/);
  if (p && pendingVerb) {
    routes.add(pendingVerb.toUpperCase() + ' ' + p[1]);
    pendingVerb = null;
  }
}
console.log('routes:', routes.size);
const check = (method, path) => {
  for (const r of routes) {
    const [rm, rp] = [r.slice(0, r.indexOf(' ')), r.slice(r.indexOf(' ') + 1)];
    if (rm !== method) continue;
    if (new RegExp('^' + rp.replace(/:[a-z]+/g, '[^/]+') + '$').test(path)) return true;
  }
  return false;
};
const manual = [
  ['GET', '/api/status'], ['POST', '/api/wechat/login'], ['POST', '/api/wechat/logout'],
  ['GET', '/api/config'], ['PUT', '/api/config'], ['POST', '/api/backup'],
  ['GET', '/api/personas'], ['POST', '/api/personas'],
  ['PUT', '/api/personas/x'], ['DELETE', '/api/personas/x'], ['PUT', '/api/personas/x/default'],
  ['PUT', '/api/peers/x/persona'], ['PUT', '/api/peers/x'],
  ['GET', '/api/peers/x/history'], ['GET', '/api/peers/x/memories'],
  ['GET', '/api/peers/x/diaries'], ['GET', '/api/peers/x/loops'],
  ['GET', '/api/peers/x/sources'], ['POST', '/api/peers/x/diary'],
  ['PUT', '/api/peers/x/memories/y'], ['PUT', '/api/peers/x/memories/y/pinned'],
  ['POST', '/api/peers/x/loops/y/resolve'],
  ['DELETE', '/api/peers/x/records/y'],
  ['POST', '/api/chat'], ['GET', '/api/tasks/x'], ['POST', '/api/tasks/x/retry'],
  ['POST', '/api/deliveries/x'],
  ['GET', '/api/stickers'], ['POST', '/api/stickers'],
  ['GET', '/api/stickers/x/image'], ['DELETE', '/api/stickers/x'], ['POST', '/api/stickers/x/enable'],
  ['GET', '/api/models'], ['POST', '/api/test-llm'], ['POST', '/api/test-embedding'],
  ['POST', '/api/login'], ['POST', '/api/logout'],
];
let bad = 0;
for (const [m, p] of manual)
  if (!check(m, p)) {
    console.log('UNMATCHED:', m, p);
    bad++;
  }
console.log(bad === 0 ? 'ALL ' + manual.length + ' frontend calls have backend routes' : bad + ' unmatched');
const used = new Set(manual.map(([m, p]) => m + ' ' + p));
for (const r of routes) {
  const [rm, rp] = [r.slice(0, r.indexOf(' ')), r.slice(r.indexOf(' ') + 1)];
  if (['/', '/healthz', '/app.js', '/app.css'].includes(rp)) continue;
  const ok = [...used].some((u) => {
    const [um, up] = [u.slice(0, u.indexOf(' ')), u.slice(u.indexOf(' ') + 1)];
    return um === rm && new RegExp('^' + rp.replace(/:[a-z]+/g, '[^/]+') + '$').test(up);
  });
  if (!ok) console.log('backend route unused by UI:', r);
}
