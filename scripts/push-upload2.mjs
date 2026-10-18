// Push one change set with a multi-line message, avoiding shell quoting.
// gh gets properly separated argv (no embedded-string args), and file
// payloads go through stdin so Windows temp paths never need quoting.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const payloadFile = process.argv[2];
const messageFile = process.argv[3];
const repo = 'cy-2-u/ATRI';
const branch = 'main';
const gh = (args, input) => {
  const argv = ['api', ...args];
  if (input !== undefined) argv.push('--input', '-');
  return String(
    execFileSync('gh', argv, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      input: input ?? '',
    }),
  ).trim();
};
// One JSON body per call, piped via stdin: no temp files, no quoting.
const post = (path, body) => JSON.parse(gh([path, '--method', 'POST'], JSON.stringify(body)));
const items = readFileSync(payloadFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const message = readFileSync(messageFile, 'utf8');
console.log(`uploading ${items.length} files to ${repo}:${branch}`);

const head = JSON.parse(gh([`repos/${repo}/git/ref/heads/${branch}`]));
const baseSha = head.object.sha;
console.log('base:', baseSha);

const blobs = new Map();
let done = 0;
const work = [...items];
async function uploadOne(item) {
  const res = post(`repos/${repo}/git/blobs`, {
    content: item.content,
    encoding: 'base64',
  });
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

const tree = items.map((item) => ({
  path: item.path,
  mode: '100644',
  type: 'blob',
  sha: blobs.get(item.path),
}));
const treeRes = post(`repos/${repo}/git/trees`, { base_tree: baseSha, tree });
console.log('tree:', treeRes.sha);

const commit = post(`repos/${repo}/git/commits`, {
  message,
  tree: treeRes.sha,
  parents: [baseSha],
});
console.log('commit:', commit.sha);

post(`repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log(`branch ${branch} updated to ${commit.sha}`);
