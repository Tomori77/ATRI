// Build a push-upload2 payload (one JSON object per line) from a list of paths.
// Deletions are expressed as { path, sha: null } which the Git Data API treats
// as "remove this path from the tree", so one script covers adds and deletes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const listFile = process.argv[3];
const outFile = process.argv[4];
const paths = readFileSync(listFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const items = paths.map((path) => {
  const abs = join(root, path);
  if (path.startsWith('-')) {
    const real = path.slice(1);
    return { path: real, sha: null };
  }
  if (!existsSync(abs)) throw new Error(`missing file: ${path}`);
  return { path, content: readFileSync(abs).toString('base64'), encoding: 'base64' };
});
writeFileSync(outFile, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
console.log(`${items.length} entries -> ${outFile}`);