// Compute git blob SHAs with checkout normalization (CRLF -> LF for text
// files, matching what git does with `* text=auto`), and list changed paths.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const remoteFile = process.argv[3];
const skip = new Set(['node_modules', 'dist', 'data', '.git']);
const BINARY_EXT = /\.(png|jpe?g|webp|gif|ico|woff2?|ttf|zip|gz)$/i;
const CRLF_EXT = /\.bat$/i; // .gitattributes keeps CRLF for these
const remote = new Map();
for (const line of readFileSync(remoteFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const i = line.indexOf(' ');
  if (i > 0) remote.set(line.slice(i + 1), line.slice(0, i));
}
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
})(root);
const storageBytes = (full) => {
  const bytes = readFileSync(full);
  if (CRLF_EXT.test(full) || BINARY_EXT.test(full) || bytes.includes(0)) return bytes;
  // Working-copy text with CRLF is usually stored as LF, but some blobs were
  // committed before normalization applied — the caller tries both hashes.
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
};
const blobSha = (bytes) =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
const changed = [];
for (const full of files) {
  const path = full.slice(root.length + 1).replaceAll('\\', '/');
  const bytes = storageBytes(full);
  const raw = readFileSync(full);
  const sha = blobSha(bytes);
  const shaRaw = blobSha(raw);
  const expected = remote.get(path);
  // Unchanged when either the LF-normalized or the raw bytes match remote.
  if (expected !== sha && expected !== shaRaw)
    changed.push({ path, file: full, bytes: expected === shaRaw ? raw : bytes });
  // Full change list for upload: emit path + base64 payload when requested.
  if (process.argv[4] === '--payload')
    console.error(JSON.stringify({ path, bytes: bytes.length }));
}
if (process.argv[4] === '--payload') {
  for (const item of changed)
    console.log(JSON.stringify({ path: item.path, content: item.bytes.toString('base64') }));
} else console.log(JSON.stringify(changed.map((c) => c.path)));
