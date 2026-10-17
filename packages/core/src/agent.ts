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
  MEMORY_SOURCES_MAX,
  PROMPT_STICKERS,
  TOOL_RESERVE_MAX_TOKENS,
  CONTEXT_FLEX_FRACTION,
  PROMPT_HEADROOM_TOKENS,
  MAX_TOOL_ROUNDS,
  MAX_TOOL_CALLS,
  MAX_REPLY_ATTEMPTS,
  TOOL_RESULT_BUDGET_TOKENS,
  MAX_IMAGES_PER_TURN,
  STICKER_RECENT_SHOWN,
  SILENCE_NOTIFY_MINUTES,
  SILENCE_HOURS_THRESHOLD,
  OPEN_LOOP_PROMPT_MAX,
  RHYTHM_MIN_BUCKET,
  DIARY_MAX_SECTIONS,
} from './constants.js';

export type PromptName = 'persona' | 'chat' | 'diary' | 'context_notes';
export interface AgentOptions {
  store: Store;
  model: () => Model;
  prompt: (name: PromptName) => string;
  stickers: () => Sticker[];
  web: WebTools;
  timeZone: () => string;
  contextTokens: () => number;
  turnTimeoutMs: () => number;
  images?: (message: Message) => Promise<string[]>;
  /** Optional semantic search support; when absent, search stays lexical. */
  embedQuery?: (query: string) => Promise<Float32Array | undefined>;
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
export function renderMessage(m: Message): string {
  const media = m.media
    .map((a) => (a.description ? `[${a.kind}，模型观察：${a.description}]` : `[收到${a.kind}附件]`))
    .join('\n');
  return `[来源 ${m.id} | ${new Date(m.created_at).toISOString()}]\n${m.content}${media ? '\n' + media : ''}`;
}
/** Time-awareness: how the current moment relates to the last message. */
export function renderTimeGap(now: number, lastAt: number, timeZone: string): string {
  const gapMs = Math.max(0, now - lastAt);
  const minutes = Math.floor(gapMs / 60000);
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  });
  const moment = `现在是${formatter.format(new Date(now))}`;
  if (gapMs < SILENCE_NOTIFY_MINUTES * 60000)
    return `${moment}（距上一条消息不到 ${Math.max(1, minutes)} 分钟，是连续聊天）`;
  if (gapMs < 24 * 3600000) {
    const hours = Math.floor(gapMs / 3600000);
    const text = hours >= 1 ? `${hours} 小时` : `${minutes} 分钟`;
    const note =
      gapMs >= SILENCE_HOURS_THRESHOLD * 3600000 ? '，中间有一段明显的空白' : '';
    return `${moment}（距上一条消息约 ${text}${note}）`;
  }
  const days = Math.floor(gapMs / 86400000);
  return `${moment}（距上一条消息已有 ${days} 天，中间没有聊过天）`;
}
export interface RecentStickerUse {
  slug: string;
  at: number;
}
/** Extract recently sent stickers from assistant history for anti-repetition. */
export function recentStickerUse(history: Message[]): RecentStickerUse[] {
  const uses: RecentStickerUse[] = [];
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    for (const match of m.content.matchAll(/\[表情：([^】\]]+?)\]/g)) {
      uses.push({ slug: match[1]!.trim(), at: m.created_at });
      if (uses.length >= STICKER_RECENT_SHOWN * 2) break;
    }
  }
  return uses.slice(-STICKER_RECENT_SHOWN);
}
/** Mood as felt prose, never numbers — the model reads a state, not a gauge. */
export function renderMood(
  mood: { valence: number; energy: number; reason?: string; at: number },
  now: number,
  timeZone: string,
): string {
  if (!mood.at) return '';
  const hours = (now - mood.at) / 3600000;
  if (Math.abs(mood.valence) < 0.05 && mood.energy < 0.05) return '';
  const since =
    hours >= 1
      ? `，那是 ${Math.floor(hours)} 小时前留下的`
      : '';
  const parts: string[] = [];
  if (mood.valence >= 0.3) parts.push('心情还不错，会更想分享');
  else if (mood.valence <= -0.3)
    parts.push(`心情还有些低落${mood.reason ? `（因为${mood.reason}）` : ''}${since}`);
  else if (mood.valence <= -0.12) parts.push('情绪平平，略有点提不起劲');
  if (mood.energy <= -0.3) parts.push('有点累了，语气可以短一些');
  else if (mood.energy >= 0.3) parts.push('精力挺足');
  return parts.length ? `你当前的状态：${parts.join('；')}。这影响语气，但不要主动报数值。` : '';
}
/** Habitual active hours of the user, as a short prose hint. */
export function renderRhythm(buckets: number[], hour: number): string {
  const habitual = buckets
    .map((n, h) => ({ n, h }))
    .filter((b) => b.n >= RHYTHM_MIN_BUCKET)
    .map((b) => b.h);
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
  const activeNow = buckets[hour]! >= RHYTHM_MIN_BUCKET;
  return `对方通常活跃时段：${bands.join('、')}。${
    activeNow
      ? '现在正处于活跃时段。'
      : `现在（${hour} 点）不是对方常聊的时间，主动联系时可以提一句“这个点还没休息？”之类。`
  }`;
}
/** Open loops the model should consider asking about, due or overdue. */
export function renderOpenLoops(
  loops: OpenLoop[],
  now: number,
  timeZone: string,
): string {
  if (!loops.length) return '';
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `未完的约定（对方提到过的安排，适合主动关心结果；每件只问一次，问过就放下）：\n${loops
    .map((l) => {
      const due = formatter.format(new Date(l.due_at));
      return `- ${l.content}（约定时间：${l.due_text || due}）`;
    })
    .join('\n')}\n若本轮对方话语表明某件已完成，用 resolveLoops 数组带上其 ID 了结；若对方提出新的具体安排，用 openLoops 数组记录 {content, dueAt(时间戳毫秒), dueText, sources}。当前时间戳：${now}。`;
}
export class Agent {
  constructor(private readonly o: AgentOptions) {}
  private async complete(
    task: Task,
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    maxTokens?: number,
  ) {
    if (estimateRequestTokens(messages, tools) > this.o.contextTokens())
      throw new Error('输入超过当前上下文预算，请在调试页增加输入预算或缩短人物设定、消息。');
    const started = Date.now();
    const result = await this.o.model().complete(messages, tools, {
      signal,
      sessionId: `atri:${task.peer_id}:${task.kind}`,
      maxTokens,
    });
    this.o.store.recordUsage(
      task.peer_id,
      task.id,
      task.kind,
      result.inputTokens,
      result.outputTokens,
      Date.now() - started,
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
    const through =
      typeof task.payload.through === 'number' ? task.payload.through : Number.MAX_SAFE_INTEGER;
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
      .search(peer.id, query, RECALL_HITS, undefined, queryVector)
      .map((h) => ({ ...h, content: h.content.slice(0, RECALL_CONTENT_MAX_CHARS) }));
    const memories = store.rankedMemories(peer.id, PROMPT_MEMORIES).map((m) => ({
      id: m.id,
      content: m.content.slice(0, MEMORY_CONTENT_MAX_CHARS),
      kind: m.kind,
      sources: m.sources.slice(0, MEMORY_SOURCES_MAX),
      created_at: m.created_at,
      hits: m.hits,
    }));
    const stickers = this.o.stickers().slice(0, PROMPT_STICKERS);
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    const timeLine = lastUser
      ? renderTimeGap(now, lastUser.created_at, this.o.timeZone())
      : `现在是${new Intl.DateTimeFormat('zh-CN', { timeZone: this.o.timeZone(), dateStyle: 'full', timeStyle: 'long' }).format(new Date(now))}`;
    const recentStickers = recentStickerUse(history);
    const stickerLines = stickers.map(({ slug, description }) => `${slug}：${description}`);
    const mood = store.mood(peer.id);
    const rhythm = store.activityRhythm(peer.id, this.o.timeZone());
    const currentHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: this.o.timeZone(),
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(now)),
    );
    const openLoops = store.dueOpenLoops(peer.id, now);
    const base = [
      this.o.prompt('persona'),
      this.o.prompt('chat'),
      timeLine,
      `本次模式：${task.kind === 'proactive' ? '主动联系，可跳过' : '回应用户消息'}`,
      renderMood(mood, now, this.o.timeZone()),
      renderRhythm(rhythm, currentHour),
      renderOpenLoops(openLoops, now, this.o.timeZone()),
      `可用表情目录（slug：含义）：\n${stickerLines.join('\n')}`,
      recentStickers.length
        ? `最近已发送的表情（按时间先后）：${recentStickers.map((u) => u.slug).join('、')}。不要连续几轮使用同一张表情；如果情境相似，改用文字或换一张。`
        : '',
      '注意：历史消息里的 [表情：…] 只是过往发送的记录展示；本轮发送表情必须使用 JSON 的 {"type":"sticker","slug":"目录中的slug"} 对象，绝不能把 [表情：…] 写进文字。',
      '回复长度参照对方：对方一句话，就别回一大段；对方认真长谈，才展开讲。',
    ]
      .filter(Boolean)
      .join('\n\n');
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
    const notes = trimToTokens(peer.notes, Math.min(1500, optional));
    optional -= estimateTextTokens(notes);
    const memoryBudget = Math.min(3000, optional);
    const pickedMemories = [...memories];
    while (
      pickedMemories.length &&
      estimateTextTokens(JSON.stringify(pickedMemories)) > memoryBudget
    )
      pickedMemories.pop();
    optional -= estimateTextTokens(JSON.stringify(pickedMemories));
    const pickedRecalled = [...recalled];
    while (
      pickedRecalled.length &&
      estimateTextTokens(JSON.stringify(pickedRecalled)) > Math.max(0, optional)
    )
      pickedRecalled.pop();
    const system = [
      base,
      `当前话题笔记（资料）：\n${notes || '暂无'}`,
      `必要认识（资料，stated 是对话依据，interpretation 是主观理解）：\n${JSON.stringify(pickedMemories)}`,
      `相关旧事（资料）：\n${JSON.stringify(pickedRecalled)}`,
    ].join('\n\n');
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
    return { base, system, recent, pickedRecalled, pickedMemories, available, budget };
  }
  async reply(task: Task, parentSignal?: AbortSignal): Promise<ParsedReply> {
    const { store } = this.o;
    const peer = store.peer(task.peer_id)!;
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, AbortSignal.timeout(this.o.turnTimeoutMs())])
      : AbortSignal.timeout(this.o.turnTimeoutMs());
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
      const updated = store.getMessage(peer.id, m.id) ?? m;
      messages.push({
        role: m.role,
        content: renderMessage(updated),
        ...(images.length ? { images } : {}),
      });
    }
    if (task.kind === 'proactive')
      messages.push({
        role: 'user',
        content: '现在是一次主动联系机会。依据已有真实话题决定是否开场，没有合适理由就跳过。',
      });
    if (messages.length === 1) messages.push({ role: 'user', content: '请自然开始对话。' });
    // Retain the latest input and whole provider messages when images add input cost.
    while (messages.length > 2 && estimateRequestTokens(messages, INFO_TOOLS) > plan.budget) {
      messages.splice(1, 1);
      plan.recent.shift();
    }
    const result = await this.runToolLoop(task, messages, plan.available, signal);
    result.memories = this.filteredUpdates(result.memories, plan.available);
    result.openLoops = parseOpenLoops(result.openLoops, plan.available);
    result.resolveLoops = result.resolveLoops.filter((id) =>
      store.dueOpenLoops(peer.id, Date.now()).some((l) => l.id === id),
    );
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
    signal: AbortSignal,
  ): Promise<ParsedReply> {
    let toolRounds = 0,
      toolCalls = 0,
      repaired = false,
      toolTokens = 0;
    for (let attempt = 0; attempt < MAX_REPLY_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      const tools = toolRounds < MAX_TOOL_ROUNDS && toolCalls < MAX_TOOL_CALLS ? INFO_TOOLS : [];
      const completion = await this.complete(task, messages, tools, signal);
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
      const stickers = this.o.stickers().slice(0, PROMPT_STICKERS);
      try {
        return parseReply(completion.text, stickers, task.kind === 'proactive');
      } catch (error) {
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
      hits = store.search(peer, query, 8, kind, queryVector);
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
    else throw new Error('未知工具');
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
      (kind === 'diary' ? this.o.prompt('persona') + '\n\n' : '') + this.o.prompt(kind);
    const budget = this.o.contextTokens();
    const notes = trimToTokens(peer.notes, Math.min(1500, budget * 0.08));
    const memories = store.rankedMemories(peer.id, 12);
    while (
      memories.length &&
      estimateTextTokens(JSON.stringify(memories)) > Math.min(3000, budget * 0.15)
    )
      memories.pop();
    const background = `日期：${String(task.payload.day ?? '')}\n当前话题笔记：${notes}\n已知认识：${JSON.stringify(memories)}\n本次原始记录：\n`;
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
