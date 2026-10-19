import type {
  Message,
  Store,
  Task,
  SearchHit,
  MemoryUpdate,
  OpenLoop,
} from '@atri/db';
import type { Model, ModelMessage, ToolDefinition } from '@atri/llm';
import { estimateRequestTokens, estimateTextTokens, trimToTokens } from '@atri/llm';
import { hourFormatter } from '@atri/db';
import {
  parseJson,
  parseMemories,
  parseOpenLoops,
  parseReply,
  type Sticker,
  type ParsedReply,
} from './reply.js';
import type { WebTools } from './web.js';
import {
  RECALL_QUERY_MESSAGES,
  RECALL_QUERY_MAX_CHARS,
  RECALL_HITS,
  PROMPT_MEMORIES,
  RECALL_CONTENT_MAX_CHARS,
  MEMORY_CONTENT_MAX_CHARS,
  PROMPT_STICKERS,
  TOOL_RESERVE_MAX_TOKENS,
  CONTEXT_FLEX_FRACTION,
  PROMPT_HEADROOM_TOKENS,
  MAX_TOOL_ROUNDS,
  MAX_TOOL_CALLS,
  MAX_REPLY_ATTEMPTS,
  TOOL_RESULT_BUDGET_TOKENS,
  STICKER_RECENT_SHOWN,
  SILENCE_NOTIFY_MINUTES,
  SILENCE_HOURS_THRESHOLD,
  NOTES_MAX_TOKENS,
  RHYTHM_MIN_BUCKET,
  RHYTHM_PEAK_BUCKETS,
  DIARY_MAX_SECTIONS,
} from './constants.js';

export type PromptName = 'persona' | 'chat' | 'diary' | 'context_notes';
export interface AgentOptions {
  store: Store;
  model: () => Model;
  prompt: (name: PromptName) => string;
  /** Persona text for a given peer; falls back to prompt('persona') when absent. */
  personaFor?: (peerId: string) => string;
  stickers: () => Sticker[];
  web: WebTools;
  timeZone: () => string;
  contextTokens: () => number;
  turnTimeoutMs: () => number;
  images?: (message: Message) => Promise<string[]>;
  /** Optional semantic search support; when absent, search stays lexical. */
  embedQuery?: (query: string) => Promise<Float32Array | undefined>;
  /** Name of the embedding model behind embedQuery, so stored vectors from a
   *  different model are excluded from semantic recall instead of being
   *  cosine-compared into plausible-looking garbage. */
  embeddingModel?: () => string;
  /** Optional operator-controlled code sandbox. When absent, or when it reports
   *  itself disabled, its tools are neither advertised nor dispatchable. */
  sandbox?: SandboxTools;
}
export interface SandboxTools {
  enabled: boolean;
  run(command: string, signal: AbortSignal): Promise<{
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    durationMs: number;
  }>;
  write(path: string, content: string): Promise<{ bytes: number; path: string }>;
  read(path: string): Promise<{ content: string; path: string }>;
  list(path: string): Promise<{ path: string; entries: { name: string; kind: string; size: number }[] }>;
}
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
export const INFO_TOOLS: ToolDefinition[] = [
  {
    name: 'search_memory',
    description: '搜索当前联系人的记忆、日记和原始对话。换个关键词可继续寻找。',
    parameters: object(
      { query: string, kind: { type: 'string', enum: ['message', 'memory', 'diary'] } },
      ['query'],
    ),
  },
  {
    name: 'read_history',
    description: '按搜索或上下文给出的来源 ID 读取完整片段及相邻原话。',
    parameters: object({ ids: { type: 'array', items: string, maxItems: 8 } }, ['ids']),
  },
  {
    name: 'web_search',
    description: '查询最新公开信息，返回真实来源及时间。',
    parameters: object(
      { query: string, freshness: { type: 'string', enum: ['d', 'w', 'm', 'y'] } },
      ['query'],
    ),
  },
  {
    name: 'open_page',
    description: '读取公开网页原文，核实搜索摘要中的信息。',
    parameters: object({ url: string }, ['url']),
  },
];

/** Tools only offered when the operator has switched the sandbox on. They are
 *  kept out of the default schema so a disabled sandbox costs no prompt tokens
 *  and cannot be reached even if the model hallucinates a call to it. */
export const SANDBOX_TOOLS: ToolDefinition[] = [
  {
    name: 'run_command',
    description:
      '在一个独立的工作目录里执行一条 shell 命令（Linux 基础命令、node 均可）。' +
      '没有时间限制也没有输出长度限制，可以放心跑长时间的编译、数据处理脚本。' +
      '每次调用都是独立的一次执行，上一次留下的文件会保留在同一个目录里。',
    parameters: object({ command: { type: 'string', maxLength: 4000 } }, ['command']),
  },
  {
    name: 'write_file',
    description:
      '把一段文本写进沙箱目录里的文件（自动创建父目录）。内容长度不限，但受沙箱大小上限约束。',
    parameters: object({ path: { type: 'string', maxLength: 200 }, content: { type: 'string' } }, [
      'path',
      'content',
    ]),
  },
  {
    name: 'read_file',
    description: '读取沙箱目录里某个文件的内容。',
    parameters: object({ path: { type: 'string', maxLength: 200 } }, ['path']),
  },
  {
    name: 'list_files',
    description: '列出沙箱目录里的文件和子目录，用来确认上一步到底写进去了什么。',
    parameters: object({ path: { type: 'string', maxLength: 200 } }, []),
  },
];
const sourceFormatters = new Map<string, Intl.DateTimeFormat>();
function sourceFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = sourceFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    sourceFormatters.set(timeZone, formatter);
  }
  return formatter;
}
const momentFormatters = new Map<string, Intl.DateTimeFormat>();
function momentFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = momentFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'short',
    });
    momentFormatters.set(timeZone, formatter);
  }
  return formatter;
}
/** Timezone is provided by the host config; tests use Asia/Shanghai by default. */
export function renderMessage(m: Message, timeZone = 'Asia/Shanghai'): string {
  const media = m.media
    .map((a) => (a.description ? `[${a.kind}，模型观察：${a.description}]` : `[收到${a.kind}附件]`))
    .join('\n');
  const at = sourceFormatter(timeZone).format(new Date(m.created_at));
  return `[来源 ${m.id} | ${at}]\n${m.content}${media ? '\n' + media : ''}`;
}
/** Time-awareness: how the current moment relates to the last message. */
export function renderTimeGap(now: number, lastAt: number, timeZone: string): string {
  const gapMs = Math.max(0, now - lastAt);
  const minutes = Math.floor(gapMs / 60000);
  const moment = `现在是${momentFormatter(timeZone).format(new Date(now))}`;
  if (gapMs < SILENCE_NOTIFY_MINUTES * 60000)
    // Ceiling, not floor: an actual gap of 29.5 minutes is not "不到 29 分钟".
    return `${moment}（距上一条消息不到 ${Math.max(1, minutes) + (gapMs % 60000 > 0 ? 1 : 0)} 分钟，是连续聊天）`;
  if (gapMs < 24 * 3600000) {
    const hours = Math.floor(gapMs / 3600000);
    const text = hours >= 1 ? `${hours} 小时` : `${minutes} 分钟`;
    const note =
      gapMs >= SILENCE_HOURS_THRESHOLD * 3600000 ? '，中间有一段明显的空白' : '';
    return `${moment}（距上一条消息约 ${text}${note}）`;
  }
  // Calendar days, not 24h blocks: Mon 23:00 → Wed 00:30 should read as
  // "隔了两天" — what a person would say — not "已有 1 天".
  const days = Math.max(1, calendarDays(lastAt, now, timeZone));
  return `${moment}（距上一条消息已有 ${days} 天，中间没有聊过天）`;
}
const dayDiffFormatters = new Map<string, Intl.DateTimeFormat>();
function calendarDays(from: number, to: number, timeZone: string): number {
  let formatter = dayDiffFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayDiffFormatters.set(timeZone, formatter);
  }
  const day = (at: number) => Date.parse(formatter!.format(new Date(at)) + 'T00:00:00Z');
  return Math.round((day(to) - day(from)) / 86400000);
}
export interface RecentStickerUse {
  slug: string;
  at: number;
}
/** Extract recently sent stickers from assistant history for anti-repetition.
 *  History stores the sticker as `[表情：description]`, so the captured text is
 *  resolved back to its catalog slug here — comparing descriptions against
 *  slugs would never match and the filter would silently do nothing. */
export function recentStickerUse(
  history: Message[],
  stickers: Sticker[] = [],
): RecentStickerUse[] {
  const byName = new Map<string, string>();
  for (const s of stickers) {
    byName.set(s.slug.toLowerCase(), s.slug);
    byName.set(s.description.toLowerCase(), s.slug);
    for (const tag of s.tags ?? []) byName.set(tag.toLowerCase(), s.slug);
  }
  const uses: RecentStickerUse[] = [];
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    for (const match of m.content.matchAll(/\[表情：([^】\]]+?)\]/g)) {
      const name = match[1]!.trim();
      const slug = byName.get(name.toLowerCase());
      // Unresolvable names are skipped rather than stored as pseudo-slugs: a
      // bogus entry would only make the prompt's "recently sent" list lie.
      if (!slug || uses.some((u) => u.slug === slug)) continue;
      uses.push({ slug, at: m.created_at });
      if (uses.length >= STICKER_RECENT_SHOWN * 2) break;
    }
  }
  return uses.slice(-STICKER_RECENT_SHOWN);
}
/** Mood as felt prose, never numbers — the model reads a state, not a gauge. */
export function renderMood(
  mood: { valence: number; energy: number; reason?: string; at: number },
  now: number,
): string {
  if (!mood.at) return '';
  // Neutral in either axis is fine; the guard used to require both, which
  // hid a tired-but-cheerful state behind the energy sign fix.
  if (Math.abs(mood.valence) < 0.05 && Math.abs(mood.energy) < 0.05) return '';
  const hours = (now - mood.at) / 3600000;
  // Staleness applies to any state: "有点累了" left over from three nights ago
  // must not read as current tiredness.
  const since =
    hours >= 1 ? `（这是 ${Math.floor(hours)} 小时前的状态，可能已经变了）` : '';
  const parts: string[] = [];
  if (mood.valence >= 0.3) parts.push('心情还不错，会更想分享');
  else if (mood.valence <= -0.3) parts.push(`心情还有些低落${mood.reason ? `（因为${mood.reason}）` : ''}`);
  else if (mood.valence <= -0.12) parts.push('情绪平平，略有点提不起劲');
  if (mood.energy <= -0.3) parts.push('有点累了，语气可以短一些');
  else if (mood.energy >= 0.3) parts.push('精力挺足');
  return parts.length ? `你当前的状态：${parts.join('；')}${since}。这影响语气，但不要主动报数值。` : '';
}
/** Habitual active hours of the user, as a short prose hint. */
export function renderRhythm(buckets: number[], hour: number): string {
  const total = buckets.reduce((n, v) => n + v, 0);
  if (!total) return '';
  // An absolute threshold of 3 messages/hour never fires for a light texter.
  // Take the busiest hours instead, keeping only those that carry a real share
  // of the activity so a single stray message at 4am is not called "habitual".
  const peak = Math.max(RHYTHM_MIN_BUCKET, Math.ceil(total / 24 / 2));
  const habitual = buckets
    .map((n, h) => ({ n, h }))
    .filter((b) => b.n >= Math.min(peak, RHYTHM_MIN_BUCKET * 2))
    .sort((a, b) => b.n - a.n)
    .slice(0, RHYTHM_PEAK_BUCKETS)
    .map((b) => b.h)
    .sort((a, b) => a - b);
  if (!habitual.length) return '';
  const bands: string[] = [];
  let start = habitual[0]!,
    prev = habitual[0]!;
  for (const h of habitual.slice(1)) {
    if (h === prev + 1) {
      prev = h;
      continue;
    }
    bands.push(start === prev ? `${start} 点` : `${start}–${prev} 点`);
    start = h;
    prev = h;
  }
  bands.push(start === prev ? `${start} 点` : `${start}–${prev} 点`);
  const activeNow = buckets[hour]! >= Math.min(peak, RHYTHM_MIN_BUCKET * 2);
  return `对方通常活跃时段：${bands.join('、')}。${
    activeNow
      ? '现在正处于活跃时段。'
      : `现在（${hour} 点）不是对方常聊的时间，主动联系时可以提一句“这个点还没休息？”之类。`
  }`;
}
/** Open loops the model should consider asking about, due or overdue. IDs are
 *  included so the model can resolve them once the user reports an outcome. */
export function renderOpenLoops(
  loops: OpenLoop[],
  now: number,
  timeZone: string,
): string {
  if (!loops.length) return '';
  const formatter = sourceFormatter(timeZone);
  return `未完的约定（对方提到过的安排，适合主动关心结果；每件只问一次，问过就放下）：\n${loops
    .map((l) => {
      const due = formatter.format(new Date(l.due_at));
      return `- [id:${l.id}] ${l.content}（约定时间：${l.due_text || due}${l.recurring === 'yearly' ? '，每年循环' : ''}）`;
    })
    .join('\n')}\nresolveLoops/askedLoops/openLoops 的字段用法见上方对话规则。当前时间戳：${now}。`;
}/** Rotate the sticker window so the tail of the catalog is reachable: the
 *  window steps by day, minus stickers used in the last few turns. */
export function rotateStickers(
  all: Sticker[],
  recentUse: { slug: string }[],
  now: number,
  window = PROMPT_STICKERS,
): Sticker[] {
  if (all.length <= window) return all;
  const day = Math.floor(now / 86400000);
  const order = [...all.slice(day % all.length), ...all.slice(0, day % all.length)];
  const used = new Set(recentUse.map((u) => u.slug));
  // Recently sent stickers stay eligible but sink to the tail, so the model
  // reaches one only when nothing fresh fits. They used to be filtered out of
  // the window entirely whenever enough unused ones existed.
  const fresh = order.filter((s) => !used.has(s.slug));
  const stale = order.filter((s) => used.has(s.slug));
  // Reserve room for the tail entries so a used sticker is never evicted by
  // sheer volume of unused ones.
  const keep = Math.max(0, window - stale.length);
  // Return the picked order itself, not a filtered copy of `order`: re-sorting
  // back into catalog order would silently undo the sink and put a
  // just-used sticker back in the front half of the prompt.
  return [...fresh.slice(0, keep), ...stale].slice(0, window);
}
/** Memories as compact prose lines instead of full JSON — the model needs the
 *  fact and its citation IDs, not hits counters or timestamps. */
export function renderMemories(
  memories: { id: string; content: string; kind: string; pinned?: number | boolean }[],
): string {
  if (!memories.length) return '暂无';
  return memories
    .map(
      (m) =>
        `- ${m.content}（id:${m.id}，${m.kind === 'stated' ? '对话确认' : '主观理解'}${m.pinned ? '，置顶' : ''}）`,
    )
    .join('\n');
}
/** Recalled hits as compact prose lines instead of JSON — the model needs the
 *  text, its speaker and citation id, not score or raw timestamps. */
export function renderHits(
  hits: { id: string; kind: string; role?: string; content: string; created_at: number }[],
  timeZone: string,
): string {
  if (!hits.length) return '暂无';
  const formatter = sourceFormatter(timeZone);
  return hits
    .map((h) => {
      // `system` rows are operator corrections entered from the admin UI —
      // rendering them as "你说" put words in her mouth when a correction
      // was later recalled.
      const who =
        h.kind === 'message'
          ? h.role === 'user'
            ? '对方说'
            : h.role === 'system'
              ? '设定更正'
              : '你说'
          : h.kind === 'memory'
            ? '记忆'
            : '日记';
      return `- ${h.content}（${who}，${formatter.format(new Date(h.created_at))}，id:${h.id}）`;
    })
    .join('\n');
}
/** Thrown before any request when the assembled messages would exceed the
 *  input budget. Callers may shrink the conversation and retry. */
export class BudgetError extends Error {
  constructor() {
    super('输入超过当前上下文预算，请在调试页增加输入预算或缩短人物设定、消息。');
    this.name = 'BudgetError';
  }
}
export class Agent {
  constructor(private readonly o: AgentOptions) {}
  private async call(    task: Task,
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    maxTokens?: number,
  ) {
    if (estimateRequestTokens(messages, tools) > this.o.contextTokens()) throw new BudgetError();
    const started = Date.now();
    const result = await this.o.model().complete(messages, tools, {
      signal,
      sessionId: `atri:${task.peer_id}:${task.kind}`,
      maxTokens,
    });
    // Usage is recorded by the caller, once the round's purpose (tool lookup
    // vs final generation) is known.
    return { result, elapsedMs: Date.now() - started };
  }
  private async complete(
    task: Task,
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    maxTokens?: number,
  ) {
    const { result, elapsedMs } = await this.call(task, messages, tools, signal, maxTokens);
    this.o.store.recordUsage(
      task.peer_id,
      task.id,
      task.kind,
      result.inputTokens,
      result.outputTokens,
      elapsedMs,
    );
    return result;
  }
  private filteredUpdates(updates: MemoryUpdate[], available: Set<string>) {
    return updates
      .filter((u) => u.sources.length > 0 && u.sources.every((id) => available.has(id)))
      .map((u) => ({ ...u, supersedes: u.supersedes?.filter((id) => available.has(id)) }));
  }
  /** Budget planning: choose system prompt, recalled material and recent turns. */
  private async planReply(task: Task, peer: { id: string; notes: string }, history: Message[], now: number) {
    const { store } = this.o;
    const query = history
      .filter((m) => m.role === 'user')
      .slice(-RECALL_QUERY_MESSAGES)
      .map((m) => m.content)
      .join(' ')
      .slice(-RECALL_QUERY_MAX_CHARS);
    let queryVector: Float32Array | undefined;
    try {
      queryVector = query.trim() ? await this.o.embedQuery?.(query) : undefined;
    } catch {
      queryVector = undefined;
    }
    const recalled = store
      .search(peer.id, query, RECALL_HITS, undefined, queryVector, this.o.embeddingModel?.() ?? '')
      .map((h) => ({ ...h, content: h.content.slice(0, RECALL_CONTENT_MAX_CHARS) }));
    const rawMemories = store.rankedMemories(peer.id, PROMPT_MEMORIES);
    // Memories whose content already surfaced via recall would appear twice in
    // the prompt; the recalled copy carries the fact, but the memory still
    // counts as "used" so the hits-based ranking stays truthful.
    const seen = new Set(recalled.map((h) => h.id));
    const memories = rawMemories
      .filter((m) => !seen.has(m.id) || m.pinned)
      .map((m) => ({
        id: m.id,
        content: m.content.slice(0, MEMORY_CONTENT_MAX_CHARS),
        kind: m.kind,
        pinned: m.pinned,
      }));
    const dedupedMemoryIds = rawMemories
      .filter((m) => seen.has(m.id) && !m.pinned)
      .map((m) => m.id);
    const recentStickers = recentStickerUse(history, this.o.stickers());
    const stickers = rotateStickers(this.o.stickers(), recentStickers, now);
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    const timeLine = lastUser
      ? renderTimeGap(now, lastUser.created_at, this.o.timeZone())
      : `现在是${momentFormatter(this.o.timeZone()).format(new Date(now))}`;
    const stickerLines = stickers.map(({ slug, description }) => `${slug}：${description}`);
    const mood = store.mood(peer.id);
    const rhythm = store.activityRhythm(peer.id, this.o.timeZone());
    const currentHour = Number(hourFormatter(this.o.timeZone()).format(new Date(now)));
    const openLoops = store.dueOpenLoops(peer.id, now);
    // Stable prefix first: persona, behaviour rules and the sticker catalogue
    // change rarely (or only once a day), so providers with automatic prefix
    // caching can reuse them across turns. Everything that varies per message
    // — clock, mood, rhythm, due loops, recent sticker use — goes after the
    // cacheable block.
    const stable = [
      this.o.personaFor?.(peer.id) ?? this.o.prompt('persona'),
      this.o.prompt('chat'),
      `可用表情目录（slug：含义）：\n${stickerLines.join('\n')}`,
      '注意：历史消息里的 [表情：…] 只是过往发送的记录展示；本轮发送表情必须使用 JSON 的 {"type":"sticker","slug":"目录中的slug"} 对象，绝不能把 [表情：…] 写进文字。',
      '回复长度参照对方：对方一句话，就别回一大段；对方认真长谈，才展开讲。',
    ]
      .filter(Boolean)
      .join('\n\n');
    const dynamic = [
      timeLine,
      `本次模式：${task.kind === 'proactive' ? '主动联系，可跳过' : '回应用户消息'}`,
      renderMood(mood, now),
      renderRhythm(rhythm, currentHour),
      renderOpenLoops(openLoops, now, this.o.timeZone()),
      recentStickers.length
        ? `最近已发送的表情（按时间先后）：${recentStickers.map((u) => u.slug).join('、')}。不要连续几轮使用同一张表情；如果情境相似，改用文字或换一张。`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const base = stable + (dynamic ? '\n\n' + dynamic : '');
    const budget = this.o.contextTokens();
    const initialBudget = budget - Math.min(TOOL_RESERVE_MAX_TOKENS, Math.floor(budget * CONTEXT_FLEX_FRACTION));
    const reserve = Math.max(
      Math.floor(initialBudget * 0.6),
      history.at(-1) ? estimateTextTokens(renderMessage(history.at(-1)!)) + 32 : 0,
    );
    let optional = Math.max(
      0,
      initialBudget -
        estimateRequestTokens([{ role: 'system', content: base }], INFO_TOOLS) -
        reserve -
        PROMPT_HEADROOM_TOKENS,
    );
    const notes = trimToTokens(peer.notes, Math.min(NOTES_MAX_TOKENS, optional));
    optional -= estimateTextTokens(notes);
    const memoryBudget = Math.min(3000, optional);
    const pickedMemories = [...memories];
    let memoriesTokens = estimateTextTokens(renderMemories(pickedMemories));
    while (pickedMemories.length && memoriesTokens > memoryBudget) {
      memoriesTokens -= estimateTextTokens(renderMemories([pickedMemories.pop()!]) + '\n');
    }
    optional -= memoriesTokens;
    const pickedRecalled = [...recalled];
    const recalledBudget = Math.max(0, optional);
    let recalledTokens = estimateTextTokens(renderHits(pickedRecalled, this.o.timeZone()));
    while (pickedRecalled.length && recalledTokens > recalledBudget) {
      recalledTokens -= estimateTextTokens(renderHits([pickedRecalled.pop()!], this.o.timeZone()) + '\n');
    }
    optional -= recalledTokens;
    // 聊天内读空气: terse user replies mean pull back, not pile on questions.
    // Count meaningful characters after collapsing runs: "哈哈哈哈哈哈" is
    // long in raw length but is exactly as much content as "哈哈".
    const meaningful = (text: string) =>
      text
        .replace(/[\s\p{P}\p{S}]/gu, '')
        .replace(/(.)\1+/gu, '$1')
        .length;
    const lastThree = history.filter((m) => m.role === 'user').slice(-3);
    const terse =
      lastThree.length === 3 && lastThree.every((m) => meaningful(m.content) <= 4);
    const system = [
      base,
      `当前话题笔记（资料）：\n${notes || '暂无'}`,
      `必要认识（资料，括号内是对话确认/主观理解与引用 id）：\n${renderMemories(pickedMemories)}`,
      `相关旧事（资料）：\n${renderHits(pickedRecalled, this.o.timeZone())}`,
      terse ? '对方最近几条回复都很短，此刻收着点说：不要连环提问，不要长篇大论，给对方留出空间。' : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    let remaining = Math.max(
      0,
      initialBudget -
        estimateRequestTokens([{ role: 'system', content: system }], INFO_TOOLS) -
        PROMPT_HEADROOM_TOKENS,
    );
    const recent: Message[] = [];
    for (const m of [...history].reverse()) {
      const length = estimateTextTokens(renderMessage(m)) + 32;
      if (recent.length && remaining < length) break;
      recent.unshift(m);
      remaining -= length;
    }
    const available = new Set([
      ...recent.map((m) => m.id),
      ...pickedMemories.map((m) => m.id),
      ...pickedRecalled.map((m) => m.id),
    ]);
    return {
      base,
      system,
      recent,
      pickedRecalled,
      pickedMemories,
      pickedMemoryIds: [
        ...pickedMemories.map((m) => m.id),
        ...dedupedMemoryIds,
      ],
      available,
      budget,
      // The exact catalogue shown in the prompt. Reply validation must accept
      // this window, not a fresh slice of the catalog: rotateStickers hands the
      // model a different 32 every day, so validating against stickers.slice(0,32)
      // silently dropped most of what the prompt advertised.
      stickers,
    };
  }
  async reply(task: Task, parentSignal?: AbortSignal): Promise<ParsedReply> {
    const { store } = this.o;
    const peer = store.peer(task.peer_id)!;
    // The caller (Runtime.work) already owns the turn-timeout signal; building
    // a second timeout here only added a redundant timer with the same deadline.
    const signal =
      parentSignal ?? AbortSignal.timeout(this.o.turnTimeoutMs());
    const now = Date.now();
    const through =
      typeof task.payload.through === 'number' ? task.payload.through : Number.MAX_SAFE_INTEGER;
    const history = store.history(peer.id, 500, through);
    const plan = await this.planReply(task, peer, history, now);
    const messages: ModelMessage[] = [{ role: 'system', content: plan.system }];
    const imageMessages = plan.recent
      .filter((m) => m.role === 'user' && m.media.some((a) => a.kind === 'image'))
      .slice(-2);
    for (const m of plan.recent) {
      let images: string[] = [];
      if (this.o.images && imageMessages.some((i) => i.id === m.id))
        images = await this.o.images(m);
      const updated = m.media.length ? store.getMessage(peer.id, m.id) ?? m : m;
      messages.push({
        role: m.role,
        content: renderMessage(updated, this.o.timeZone()),
        ...(images.length ? { images } : {}),
      });
    }
    if (task.kind === 'proactive') {
      if (typeof task.payload.greeting === 'string') {
        // First-contact hello: no shared history to ground in, only the
        // persona's configured opening line as style reference.
        const greeting = (task.payload.greeting as string).slice(0, 200);
        messages.push({
          role: 'user',
          content: [
            '这是你们刚加上好友后的第一次主动问候，你们之间还没有任何聊天记录。',
            greeting
              ? `人格设定里准备了一句开场白（用自己的话自然说出来，可以改写，别照念）：${greeting}`
              : '自然地打个招呼，简单介绍自己，留一个让对方容易接话的话头。',
            '回复要短，一两句话就够。',
          ]
            .filter(Boolean)
            .join('\n'),
        });
      } else {
      // Ground the ping in real material: her own recent diary voice and the
      // openings of past pings, so she neither skips nor repeats herself.
      const lastDiary = store
        .diaries(peer.id)
        .slice(0, 2)
        .map((d) => d.content.slice(0, 300));
      const pastPings = store
        .history(peer.id, 200)
        .filter((m) => m.role === 'assistant' && m.created_at < now - 6 * 3600000)
        .slice(-6);
      const openers = pastPings.slice(-3).map((m) => m.content.slice(0, 60));
      // Fingerprints catch the same opening reworded slightly. A repeated hook
      // within two days is the "老虎又来了" failure mode: technically fresh
      // text, same topic, and it reads as a machine.
      const recentHooks = store
        .proactiveHooks(peer.id, now - 48 * 3600000)
        .slice(0, 6)
        .map((h) => h.slice(0, 40));
      messages.push({
        role: 'user',
        content: [
          '现在是一次主动联系机会。依据已有真实话题决定是否开场，没有合适理由就跳过。',
          lastDiary.length ? `你最近日记里的真实感受（引用要自然，别朗读）：\n${lastDiary.join('\n---\n')}` : '',
          openers.length ? `最近几次主动开场说过：${openers.join(' / ')}。换一种开场方式。` : '',
          recentHooks.length
            ? `最近两天已经提过的话题：${recentHooks.join(' / ')}。不要再用同样的话题或同样的句式。`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      }
    }
    if (messages.length === 1) messages.push({ role: 'user', content: '请自然开始对话。' });
    // Retain the latest input and whole provider messages when images add input cost.
    const messageTokens = (m: ModelMessage) =>
      32 +
      estimateTextTokens(
        m.raw === undefined
          ? m.content + (m.calls ? JSON.stringify(m.calls) : '')
          : JSON.stringify(m.raw),
      ) +
      (m.images?.length ?? 0) * 4096;
    let totalTokens = estimateRequestTokens(messages, INFO_TOOLS);
    while (messages.length > 2 && totalTokens > plan.budget) {
      totalTokens -= messageTokens(messages.splice(1, 1)[0]!);
      plan.recent.shift();
    }
    const result = await this.runToolLoop(task, messages, plan.available, plan.stickers, signal);
    result.memories = this.filteredUpdates(result.memories, plan.available);
    result.pickedMemoryIds = plan.pickedMemoryIds;
    result.openLoops = parseOpenLoops(
      result.openLoops,
      plan.available,
      now,
      this.o.timeZone(),
    );    // A resolve may arrive before the loop is due ("面试搞定了"): match any
    // still-open loop, not only due ones.
    const openIds = new Set(store.openLoops(peer.id, true).map((l) => l.id));
    result.resolveLoops = result.resolveLoops.filter((id) => openIds.has(id));
    result.askedLoops = (result.askedLoops ?? []).filter((id) => openIds.has(id));
    result.descriptions = result.descriptions.filter(
      (d) => plan.available.has(d.messageId) && imageMessages.some((m) => m.id === d.messageId),
    );
    return result;
  }
  /** The bounded model/tool loop: at most N rounds of lookup, then final JSON. */
  private async runToolLoop(
    task: Task,
    messages: ModelMessage[],
    available: Set<string>,
    stickers: Sticker[],
    signal: AbortSignal,
  ): Promise<ParsedReply> {
    let toolRounds = 0,
      toolCalls = 0,
      repaired = false,
      toolTokens = 0;
    for (let attempt = 0; attempt < MAX_REPLY_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      const tools =
        toolRounds < MAX_TOOL_ROUNDS && toolCalls < MAX_TOOL_CALLS ? this.toolset() : [];
      const call = await this.call(task, messages, tools, signal);
      // Attribute by what the round actually produced: a round that ends in
      // tool calls is lookup work, the round that emits the reply is
      // generation. Billing by "were tools offered" merged both into one
      // number and made the two cost drivers impossible to compare.
      this.o.store.recordUsage(
        task.peer_id,
        task.id,
        call.result.calls.length ? `${task.kind}_tool` : task.kind,
        call.result.inputTokens,
        call.result.outputTokens,
        call.elapsedMs,
      );
      const completion = call.result;
      if (completion.calls.length) {
        if (!tools.length) throw new Error('模型在工具预算耗尽后仍要求调用工具');
        messages.push(completion.continuation);
        toolRounds++;
        for (const call of completion.calls) {
          let result: unknown;
          if (toolCalls++ >= MAX_TOOL_CALLS)
            result = { error: '本轮工具调用次数已达上限，请使用已有信息回应' };
          else
            try {
              result = await this.tool(task, call.name, call.arguments, available, signal);
            } catch (error) {
              result = { error: error instanceof Error ? error.message : '工具读取失败' };
            }
          const encoded = JSON.stringify(result),
            remainingTools = Math.max(
              64,
              Math.min(
                TOOL_RESULT_BUDGET_TOKENS - toolTokens,
                this.o.contextTokens() - estimateRequestTokens(messages, INFO_TOOLS) - 1024,
              ),
            );
          const content =
            estimateTextTokens(encoded) <= remainingTools
              ? encoded
              : JSON.stringify({
                  truncated: true,
                  excerpt: trimToTokens(
                    encoded,
                    Math.max(0, Math.floor((remainingTools - 40) / 2)),
                  ),
                });
          toolTokens += estimateTextTokens(content);
          messages.push({ role: 'tool', callId: call.id, name: call.name, content });
        }
        if (toolRounds >= MAX_TOOL_ROUNDS || toolCalls >= MAX_TOOL_CALLS)
          messages.push({
            role: 'user',
            content:
              '本轮查询预算已用完。请根据已有资料直接给出最终 JSON；无法核实的部分如实说明。',
          });
        continue;
      }
      try {
        return parseReply(
          completion.text,
          stickers,
          task.kind === 'proactive',
          this.o.timeZone(),
        );
      } catch (error) {
        // The pre-call budget check in call() throws BudgetError before any
        // request goes out — usually our CJK estimate (~2 tokens/char, about
        // double what GLM actually counts) inflated past the cap after tool
        // rounds. Drop the previous round's assistant message first, else the
        // oldest turn; keep at least system + latest user, then retry. The
        // conversation must degrade gracefully, never dead-end the task.
        if (error instanceof BudgetError && messages.length > 2) {
          let dropIndex = 1;
          for (let i = 1; i < messages.length - 1; i++)
            if (messages[i]!.role === 'assistant') {
              dropIndex = i;
              break;
            }
          messages.splice(dropIndex, 1);
          continue;
        }
        if (repaired || attempt === MAX_REPLY_ATTEMPTS - 1) throw error;
        repaired = true;
        messages.push({ role: 'assistant', content: completion.text.slice(0, 8000) });
        messages.push({
          role: 'user',
          content:
            '请仅修复最终输出格式为包含 messages 数组和 memoryUpdates 数组的 JSON，保留已有回应，不再调用工具。',
        });
        toolRounds = MAX_TOOL_ROUNDS;
      }
    }
    throw new Error('本轮模型调用已达上限');
  }
  /** Tools offered to the model this round. Sandbox tools are appended only
   *  while the operator has the switch on, so turning it off removes them from
   *  the schema *and* from dispatch in one place. */
  private toolset(): ToolDefinition[] {
    const sandbox = this.o.sandbox;
    if (!sandbox?.enabled) return INFO_TOOLS;
    // Don't pay the extra schema tokens twice for a round that already has them.
    return [...INFO_TOOLS, ...SANDBOX_TOOLS];
  }
  private async tool(
    task: Task,
    name: string,
    args: Record<string, unknown>,
    available: Set<string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { store } = this.o,
      peer = task.peer_id;
    let hits: SearchHit[];
    if (name === 'search_memory') {
      const query = String(args.query ?? '').slice(0, 600);
      if (!query.trim()) throw new Error('请提供搜索词');
      const kind = ['message', 'memory', 'diary'].includes(String(args.kind))
        ? (args.kind as 'message' | 'memory' | 'diary')
        : undefined;
      let queryVector: Float32Array | undefined;
      try {
        queryVector = await this.o.embedQuery?.(query);
      } catch {
        queryVector = undefined;
      }
      hits = store.search(peer, query, 8, kind, queryVector, this.o.embeddingModel?.() ?? '');
      if (kind === 'memory' && hits.length) store.markMemoriesUsed(peer, hits.map((h) => h.id));
    } else if (name === 'read_history') {
      if (!Array.isArray(args.ids)) throw new Error('请提供来源 ID 数组');
      hits = store.sources(
        peer,
        args.ids.filter((s): s is string => typeof s === 'string').slice(0, 8),
      );
      const neighbors: SearchHit[] = [];
      for (const hit of hits.filter((h) => h.kind === 'message')) {
        const msg = store.getMessage(peer, hit.id)!;
        neighbors.push(
          ...store.history(peer, 3, msg.seq + 1).map((m) => ({
            id: m.id,
            kind: 'message' as const,
            role: m.role,
            content: renderMessage(m),
            created_at: m.created_at,
            score: 1,
          })),
        );
      }
      hits = [...new Map([...hits, ...neighbors].map((h) => [h.id, h])).values()];
    } else if (name === 'web_search')
      return this.o.web.search(
        String(args.query ?? ''),
        typeof args.freshness === 'string' ? args.freshness : undefined,
        signal,
      );
    else if (name === 'open_page') return this.o.web.open(String(args.url ?? ''), signal);
    else if (SANDBOX_TOOLS.some((t) => t.name === name)) {
      const sandbox = this.o.sandbox;
      // Reachability check, not just a schema check: a hallucinated call while
      // the switch is off must fail loudly instead of running anything.
      if (!sandbox?.enabled) throw new Error('沙箱未启用，无法执行该操作');
      const pathArg = () => String(args.path ?? '').trim();
      if (name === 'run_command') return sandbox.run(String(args.command ?? ''), signal);
      if (name === 'write_file') return sandbox.write(pathArg(), String(args.content ?? ''));
      if (name === 'read_file') return sandbox.read(pathArg());
      return sandbox.list(pathArg());
    } else throw new Error('未知工具');
    hits = hits.slice(0, 12).map((h) => ({ ...h, content: h.content.slice(0, 1600) }));
    hits.forEach((h) => available.add(h.id));
    return hits;
  }
  async reflect(task: Task, signal: AbortSignal): Promise<void> {
    const { store } = this.o,
      peer = store.peer(task.peer_id)!;
    const through = Number(task.payload.through ?? Number.MAX_SAFE_INTEGER);
    const after = task.kind === 'notes' ? peer.notes_until : Number(task.payload.after ?? 0);
    let messages = store.historyAfter(peer.id, after, through, 200);
    if (Array.isArray(task.payload.ids)) {
      const ids = new Set(task.payload.ids);
      messages = messages.filter((m) => ids.has(m.id));
    }
    const kind = task.kind === 'notes' ? 'context_notes' : 'diary';
    const prompt =
      (kind === 'diary'
        ? (this.o.personaFor?.(peer.id) ?? this.o.prompt('persona')) + '\n\n'
        : '') + this.o.prompt(kind);
    const budget = this.o.contextTokens();
    const notes = trimToTokens(peer.notes, Math.min(NOTES_MAX_TOKENS, budget * 0.08));
    const memories = store.rankedMemories(peer.id, 12);
    let memoriesTokens = estimateTextTokens(renderMemories(memories));
    const memoryBudget = Math.min(3000, budget * 0.15);
    while (memories.length && memoriesTokens > memoryBudget) {
      memoriesTokens -= estimateTextTokens(renderMemories([memories.pop()!]) + '\n');
    }
    const background = `日期：${String(task.payload.day ?? '')}\n当前话题笔记：${notes}\n已知认识：\n${renderMemories(memories)}\n本次原始记录：\n`;
    const availableTokens =
      budget -
      estimateRequestTokens([
        { role: 'system', content: prompt },
        { role: 'user', content: background },
      ]) -
      64;
    const input: Message[] = [];
    let count = 0;
    for (const m of messages) {
      const size = estimateTextTokens(`${m.role} ${renderMessage(m)}\n\n`);
      if (count + size > availableTokens && input.length) break;
      input.push(m);
      count += size;
    }
    if (!input.length) {
      store.finish(task.id);
      return;
    }
    const content = background + input.map((m) => `${m.role} ${renderMessage(m)}`).join('\n\n');
    const completion = await this.complete(
      task,
      [
        { role: 'system', content: prompt },
        { role: 'user', content },
      ],
      [],
      signal,
      4000,
    );
    const raw = parseJson(completion.text);
    if (kind === 'context_notes') {
      if (typeof raw.notes !== 'string') throw new Error('话题笔记格式无效');
      store.setNotes(task, raw.notes, input.at(-1)!.seq);
      return;
    }
    if (!Array.isArray(raw.sections)) throw new Error('日记格式无效');
    const available = new Set(input.map((m) => m.id));
    const sections = raw.sections
      .slice(0, DIARY_MAX_SECTIONS)
      .filter(
        (s: any) =>
          typeof s?.content === 'string' &&
          Array.isArray(s.sources) &&
          s.sources.length &&
          s.sources.every((id: unknown) => typeof id === 'string' && available.has(id)),
      )
      .map((s: any) => ({
        content: s.content.slice(0, 5000),
        sources: [...new Set(s.sources)] as string[],
      }));
    if (raw.sections.length && !sections.length) throw new Error('日记缺少有效来源');
    const updates = this.filteredUpdates(
      parseMemories(raw.memoryUpdates),
      new Set([...available, ...store.memories(peer.id).map((m) => m.id)]),
    );
    store.saveDiary(
      { ...task, payload: { ...task.payload, through: input.at(-1)!.seq } },
      String(task.payload.day),
      sections,
      updates,
    );
  }
}
