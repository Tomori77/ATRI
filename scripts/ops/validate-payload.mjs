import { readFileSync } from 'node:fs';
const lines = readFileSync(process.env.TEMP + '/atri-payload.jsonl', 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean);
console.log('payload items:', lines.length);
for (const l of lines) {
  const o = JSON.parse(l);
  if (!o.path || !o.content) throw new Error('bad line: ' + l.slice(0, 50));
}
console.log('all lines valid JSON with path+content');
