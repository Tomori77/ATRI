// Create the final commit with a full message and force-move main.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const repo = 'cy-2-u/ATRI';
const tree = process.argv[2];
const parent = process.argv[3];
const message = `feat: memory ranking, hybrid vector search, time awareness, sticker fallback

- memories: hits counter plus ranked selection (usage, importance, recency with floor); corrections carry usage history
- retrieval: optional hybrid search (FTS plus embeddings via OpenAI-compatible /embeddings), background backfill, vectors invalidated on content change and delete
- time awareness: silence gap and current moment rendered into chat prompt; chat.md guidance for long gaps and late-night tone
- stickers: pseudo-protocol text from the model is matched back to catalog (slug, description or tags) and re-sent as real stickers; unmatched fragments dropped; recent usage injected to prevent repetition; prompt warns against mimicking history format
- proactive: 0-20 min random jitter; reminders and appointments as natural openers
- refactor: reply() split into budget planner and bounded tool loop; shared private-address checks in new @atri/net; magic numbers into constants; maxConcurrentPeers/debounceMs configurable in admin UI
- tests: 129 passing (was 118); smoke green`;
const gh = (args) => execSync(`gh api ${args}`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const tmp = (name) => join(tmpdir(), name);
writeFileSync(tmp('atri-commit2.json'), JSON.stringify({ message, tree, parents: [parent] }));
const commit = JSON.parse(gh(`repos/${repo}/git/commits --input "${tmp('atri-commit2.json')}" --method POST`));
writeFileSync(tmp('atri-ref2.json'), JSON.stringify({ sha: commit.sha, force: true }));
gh(`repos/${repo}/git/refs/heads/main --input "${tmp('atri-ref2.json')}" --method PATCH`);
console.log('main ->', commit.sha);
