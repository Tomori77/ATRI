// Upload changed files to GitHub via Git Data API:
// blobs (concurrency 3) -> tree -> commit -> update branch ref.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const payloadFile = process.argv[2];
const branch = process.argv[3] ?? 'main';
const message = process.argv[4] ?? 'update';
const repo = 'cy-2-u/ATRI';
const gh = (args) => execSync(`gh api ${args}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const items = readFileSync(payloadFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
console.log(`uploading ${items.length} files to ${repo}:${branch}`);

const head = JSON.parse(gh(`repos/${repo}/git/ref/heads/${branch}`));
const baseSha = head.object.sha;
console.log('base:', baseSha);

// Phase 1: blobs with concurrency 3.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const blobs = new Map();
let done = 0;
const work = [...items];
async function uploadOne(item) {
  const tmp = join(tmpdir(), 'atri-blob.json');
  writeFileSync(
    tmp,
    JSON.stringify({ content: item.content, encoding: 'base64' }),
  );
  const res = JSON.parse(gh(`repos/${repo}/git/blobs --input "${tmp}" --method POST`));
  blobs.set(item.path, res.sha);
  done++;
  if (done % 5 === 0 || done === items.length) console.log(`blobs ${done}/${items.length}`);
}
const lanes = Array.from({ length: 3 }, async () => {
  for (;;) {
    const item = work.shift();
    if (!item) return;
    await uploadOne(item);
  }
});
await Promise.all(lanes);
console.log('all blobs created');

// Phase 2: tree referencing base + new blobs.
const tree = items.map((item) => ({
  path: item.path,
  mode: '100644',
  type: 'blob',
  sha: blobs.get(item.path),
}));
const tmpTree = join(tmpdir(), 'atri-tree.json');
writeFileSync(tmpTree, JSON.stringify({ base_tree: baseSha, tree }));
const treeRes = JSON.parse(gh(`repos/${repo}/git/trees --input "${tmpTree}" --method POST`));
console.log('tree:', treeRes.sha);

// Phase 3: commit.
const tmpCommit = join(tmpdir(), 'atri-commit.json');
writeFileSync(
  tmpCommit,
  JSON.stringify({ message, tree: treeRes.sha, parents: [baseSha] }),
);
const commit = JSON.parse(gh(`repos/${repo}/git/commits --input "${tmpCommit}" --method POST`));
console.log('commit:', commit.sha);

// Phase 4: move branch.
const tmpRef = join(tmpdir(), 'atri-ref.json');
writeFileSync(
  tmpRef,
  JSON.stringify({ sha: commit.sha, force: false }),
);
gh(`repos/${repo}/git/refs/heads/${branch} --input "${tmpRef}" --method PATCH`);
console.log(`branch ${branch} updated to ${commit.sha}`);
