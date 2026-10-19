import type { Store, Peer, ReplyPart, Task, Media, MemoryUpdate } from '@atri/db';
import { hourFormatter } from '@atri/db';
import { Agent, renderMessage, type AgentOptions } from './agent.js';
import { estimateTextTokens, cosineSimilarity } from '@atri/llm';
import {
  NOTES_MIN_MESSAGES,
  NOTES_WINDOW,
  NOTES_BUDGET_SHARE,
  NOTES_TAIL_EXEMPT,
  DIARY_MAX_CHARS,
  PROACTIVE_JITTER_MINUTES,
  EMBED_BACKFILL_BATCH,
  PROACTIVE_IGNORE_LIMIT,
  PROACTIVE_IGNORE_COOLDOWN_DAYS,
  SIMILARITY_SUPERSEDE,
} from './constants.js';

/** Minimal embedding surface the runtime needs; implemented by apps/api. */
export interface Embedder {
  configured: boolean;
  model: string;
  /** Whether the operator wants vectors at all (a switch separate from config). */
  enabled?: boolean;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface RuntimeConfig {
  timeZone: string;
  diaryHour: number;
  proactiveEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  proactiveAfterHours: number;
  debounceMs: number;
  maxConcurrentPeers: number;
  turnTimeoutMs: number;
  contextTokens: number;
}
export interface Transport {
  send(peer: Peer, part: ReplyPart, clientId: string): Promise<void>;
  typing?(peer: Peer, active: boolean): Promise<void>;
}
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly certainFailure = false,
  ) {
    super(message);
  }
}
export interface RuntimeOptions extends AgentOptions {
  config: () => RuntimeConfig;
  transport: Transport;
  log?: (message: string, details?: unknown) => void;
  embedder?: Embedder;
}
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function dayAt(at: number, timeZone: string): string {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, formatter);
  }
  const p = formatter.formatToParts(new Date(at));
  return ['year', 'month', 'day'].map((t) => p.find((v) => v.type === t)!.value).join('-');
}
function hourAt(at: number, timeZone: string) {
  return Number(hourFormatter(timeZone).format(new Date(at)));
}
export function inQuietHours(hour: number, start: number, end: number) {
  return start === end
    ? false
    : start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
}
/** Loose overlap test for "did this message mention that plan": CJK bigrams and
 *  latin words of 3+ characters, ignoring stop-word-ish short tokens. */
function sharesTerm(content: string, spoken: string): boolean {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
  const body = normalize(spoken);
  const terms = normalize(content).match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.some((word) => {
    if (/\p{Script=Han}/u.test(word)) {
      if (word.length < 2) return false;
      return Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)).some((bi) =>
        body.includes(bi),
      );
    }
    return word.length >= 3 && body.includes(word);
  });
}
export class Runtime {
  readonly agent: Agent;
  private active = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; kind?: string }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private scheduleTimer?: ReturnType<typeof setInterval>;
  private embedTimer?: ReturnType<typeof setInterval>;
  private embedding = false;
  private stopped = false;
  constructor(readonly options: RuntimeOptions) {
    this.agent = new Agent(options);
  }
  get store(): Store {
    return this.options.store;
  }
  start() {
    this.store.recover();
    this.stopped = false;
    this.timer = setInterval(() => this.pump(), 300);
    this.scheduleTimer = setInterval(() => this.schedule(), 60000);
    // Vector backfill: one full drain at startup (an import of thousands of
    // rows must not take a day of 64-row drips to become searchable), then a
    // 5-minute drip keeps new content indexed without competing with chat.
    if (this.options.embedder) {
      void this.backfillEmbeddings(false);
      this.embedTimer = setInterval(() => void this.backfillEmbeddings(), 300000);
    }
    this.schedule();
    this.pump();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.embedTimer) clearInterval(this.embedTimer);
    for (const a of this.active.values()) a.controller.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
  }
  /** Index content that lacks vectors; best-effort, never blocks chat.
   *  `quick` caps the work per peer (periodic drip); a full pass at startup or
   *  after enabling vectors drains the backlog in one go instead of taking
   *  hours of 64-row batches to make a large import searchable. */
  private async backfillEmbeddings(quick = true) {
    const embedder = this.options.embedder;
    if (!embedder || this.embedding || this.stopped || !embedder.configured) return;
    if (embedder.enabled === false) return;
    this.embedding = true;
    try {
      for (const peer of this.store.peers()) {
        if (this.stopped) return;
        for (;;) {
          const pending = this.store.pendingEmbeddings(peer.id, quick ? EMBED_BACKFILL_BATCH : 512);
          if (!pending.length) break;
          const vectors = await embedder.embed(pending.map((p) => p.content));
          this.store.setEmbeddings(
            vectors.map((vector, i) => ({
              id: pending[i]!.id,
              peer: peer.id,
              kind: pending[i]!.kind,
              vector,
              model: embedder.model,
            })),
          );
          if (quick) break;
        }
      }
    } catch (error) {
      this.options.log?.('向量索引更新失败，将在下个周期重试', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.embedding = false;
    }
  }
  accept(
    peer: string,
    eventKey: string,
    content: string,
    media: Media[] = [],
    timestamp = Date.now(),
  ) {
    const result = this.store.transaction(() => {
      const event = this.store.ingest(peer, eventKey, content, media, timestamp);
      const taskId = !event.duplicate
        ? this.store.enqueueChat(peer, event.message.seq, this.options.config().debounceMs)
        : undefined;
      return { ...event, taskId };
    });
    const active = this.active.get(peer);
    if (
      active &&
      (active.kind === 'diary' || active.kind === 'notes' || active.kind === 'proactive')
    )
      active.controller.abort();
    this.pump();
    return result;
  }
  pump() {
    if (this.stopped) return;
    for (const peer of this.store.readyPeers()) {
      if (this.active.has(peer)) continue;
      if (this.active.size >= this.options.config().maxConcurrentPeers) break;
      const controller = new AbortController();
      const entry = {
        promise: Promise.resolve(),
        controller,
        kind: undefined as string | undefined,
      };
      this.active.set(peer, entry);
      entry.promise = this.work(peer, entry)
        .catch((error) => this.options.log?.('会话处理失败', { peer, error: String(error) }))
        .finally(() => {
          this.active.delete(peer);
          if (!this.stopped) queueMicrotask(() => this.pump());
        });
    }
  }
  async drain(timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      this.pump();
      if (!this.active.size && !this.store.readyPeers().length) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('等待队列处理超时');
  }
  /** Abort any in-flight turn for the peer before its records are deleted. */
  forgetPeer(peerId: string) {
    const entry = this.active.get(peerId);
    if (!entry) return;
    entry.controller.abort();
    this.active.delete(peerId);
  }
  private async work(peerId: string, entry: { controller: AbortController; kind?: string }) {
    for (let n = 0; n < 12 && !this.stopped; n++) {
      const peer = this.store.peer(peerId)!;
      if (!peer.approved) return;
      const deliveries = this.store.pendingDeliveries(peerId);
      if (deliveries.length) {
        entry.kind = 'delivery';
        const task = this.store.taskById(deliveries[0].task_id)!;
        if (task.version !== peer.version && this.store.cancelUnsent(task)) continue;
        const own = deliveries.filter((d) => d.task_id === task.id);
        for (const delivery of own) {
          this.store.startDelivery(delivery.id);
          try {
            await this.options.transport.send(this.store.peer(peerId)!, delivery.part, delivery.id);
            this.store.markDelivery(delivery.id, 'sent');
          } catch (error) {
            this.store.markDelivery(
              delivery.id,
              error instanceof DeliveryError && error.certainFailure ? 'failed' : 'uncertain',
              error instanceof Error ? error.message : '发送失败',
            );
            return;
          }
          if (delivery !== deliveries.at(-1)) {
            // Human-like pacing: longer bubbles get longer pauses, never a
            // machine-gun burst. Capped so a batch still sends promptly.
            const next = own[own.indexOf(delivery) + 1];
            const chars = next?.part.type === 'text' ? (next.part.text?.length ?? 0) : 6;
            await new Promise((r) =>
              setTimeout(r, Math.min(2500, 400 + Math.min(80, chars) * 25)),
            );
          }
        }
        this.maybeMood(peerId);
        this.maybeNotes(peerId);
        continue;
      }
      const task = this.store.claim(peerId);
      if (!task) return;
      entry.kind = task.kind;
      if (entry.controller.signal.aborted) entry.controller = new AbortController();
      const signal = AbortSignal.any([
        entry.controller.signal,
        AbortSignal.timeout(this.options.config().turnTimeoutMs),
      ]);
      try {
        if (task.kind === 'chat' || task.kind === 'proactive') {
          // Greeting tasks are the first-contact hello queued on approval; the
          // normal proactive gate (silence clock, quiet hours) would veto a
          // peer that has never messaged, so greetings skip it.
          if (
            task.kind === 'proactive' &&
            task.payload.greeting === undefined &&
            !this.proactiveGate(task, peer, Date.now())
          ) {
            this.store.finish(task.id);
            continue;
          }
          const typing = this.options.transport.typing?.(peer, true).catch(() => {});
          try {
            const reply = await this.agent.reply(task, signal);
            await this.dedupeMemories(peerId, reply.memories, signal);
            const saved = this.store.saveReply(task, reply.parts, reply.memories);
            if (saved) {
              this.applyOpenLoops(task, reply);
              // Every prompt inclusion is a memory "use", not only tool hits —
              // otherwise the hits-based ranking sees a fraction of reality.
              if (reply.pickedMemoryIds?.length)
                this.store.markMemoriesUsed(peerId, reply.pickedMemoryIds);
              if (reply.moodPulse)
                this.store.pulseMood(peerId, { ...reply.moodPulse }, Date.now());
              const usedStickers = reply.parts
                .filter((p) => p.type === 'sticker' && p.slug)
                .map((p) => p.slug!);
              if (usedStickers.length) this.store.markStickersUsed(peerId, usedStickers);
              for (const description of reply.descriptions) {
                const msg = this.store.getMessage(peerId, description.messageId);
                if (msg) {
                  this.store.updateMedia(
                    peerId,
                    msg.id,
                    msg.media.map((m) =>
                      m.kind === 'image' ? { ...m, description: description.description } : m,
                    ),
                  );
                }
              }
            }
          } finally {
            void Promise.resolve(typing)
              .then(() => this.options.transport.typing?.(peer, false))
              .catch(() => {});
          }
        } else await this.agent.reflect(task, signal);
      } catch (error) {
        if (this.stopped || entry.controller.signal.aborted) {
          this.store.finish(task.id, 'interrupted');
          this.store.retry(task.id, task.kind === 'chat' ? 0 : 60000);
        } else {
          this.store.finish(task.id, 'failed', error instanceof Error ? error.message : '任务失败');
          this.options.log?.('任务失败', { task: task.id, kind: task.kind, error: String(error) });
        }
      }
    }
  }
  /** Semantic duplicate guard: models restate known facts in new wording and
   *  only sometimes fill supersedes. Before persisting, embed each new memory
   *  and, when it lands within SIMILARITY_SUPERSEDE of an active memory vector,
   *  auto-supersede the old row so recall stays clean. Failures (no embedder,
   *  embedding error) keep the model-provided supersedes untouched. */
  private async dedupeMemories(peer: string, updates: MemoryUpdate[], signal?: AbortSignal) {
    const embedder = this.options.embedder;
    if (!updates.length || !embedder || embedder.enabled === false || !embedder.configured) return;
    const memories = this.store.embeddings(peer).filter((e) => e.kind === 'memory');
    if (!memories.length) return;
    for (const update of updates) {
      if (update.content.trim().length < 4) continue;
      let vector: Float32Array | undefined;
      try {
        [vector] = await embedder.embed([update.content], signal);
      } catch {
        continue;
      }
      if (!vector?.some((v) => v !== 0)) continue;
      let bestId = '',
        bestSim = 0;
      for (const row of memories) {
        if (row.dims !== vector.length || row.model !== embedder.model) continue;
        const sim = cosineSimilarity(vector, row.vector);
        if (sim > bestSim) {
          bestSim = sim;
          bestId = row.id;
        }
      }
      if (bestSim >= SIMILARITY_SUPERSEDE) {
        const superseded = new Set([...(update.supersedes ?? []), bestId]);
        update.supersedes = [...superseded].slice(0, 12);
      }
    }
  }
  /** Open loops: resolve loops the user just answered, record new ones,
   *  mark due loops as asked only when the model actually brought them up,
   *  and expire old ones. */
  private applyOpenLoops(
    task: Task,
    reply: {
      openLoops?: { content: string; dueAt: number; dueText?: string; sources: string[] }[];
      resolveLoops?: string[];
      askedLoops?: string[];
      parts?: { type: string }[];
    },
  ) {
    const store = this.store,
      peer = task.peer_id,
      now = Date.now();
    store.expireOpenLoops(peer, now);
    for (const id of reply.resolveLoops ?? []) store.resolveOpenLoop(peer, id, now);
    for (const loop of reply.openLoops ?? []) {
      if (!Number.isFinite(loop.dueAt) || loop.dueAt < now - 86400000) continue;
      if (!loop.sources.length) continue;
      store.addOpenLoop(peer, loop, now);
    }
    if (task.kind !== 'proactive') return;
    // A ping that says nothing (the model chose to skip) asked nothing; a ping
    // that talks about something else also asked nothing. Mark only what the
    // model reports mentioning, so "每件只问一次" holds.
    const due = new Map(store.dueOpenLoops(peer, now).map((l) => [l.id, l]));
    const explicit = (reply.askedLoops ?? []).filter((id) => due.has(id));
    const spoken = reply.parts?.map((p) => ('text' in p ? String(p.text ?? '') : '')).join(' ') ?? '';
    if (!spoken.trim()) return;
    const matched = explicit.length
      ? explicit
      : // The prompt asks for askedLoops, but a model that omits it must not
        // silence every reminder forever: fall back to the loop this ping was
        // scheduled for, then to a lexical match in what was actually said.
        typeof task.payload?.loop === 'string' && due.has(task.payload.loop)
        ? [task.payload.loop]
        : [...due.values()]
            .filter((loop) => sharesTerm(loop.content, spoken))
            .map((loop) => loop.id);
    for (const id of new Set(matched)) store.markLoopAsked(peer, id, now);
  }
  /** After a delivered exchange, pulse the light mood state from the last
   *  user/assistant pair; runs at most once per finished task batch. */
  private maybeMood(peerId: string) {
    const peer = this.store.peer(peerId);
    if (!peer) return;
    const recent = this.store.history(peerId, 2);
    const user = [...recent].reverse().find((m) => m.role === 'user');
    const assistant = [...recent].reverse().find((m) => m.role === 'assistant');
    if (user && assistant && user.created_at <= assistant.created_at)
      this.store.pulseMoodFromExchange(
        peerId,
        { user: user.content, assistant: assistant.content, userAt: user.created_at },
        Date.now(),
        this.options.config().timeZone,
      );
  }
  private maybeNotes(peerId: string) {
    const peer = this.store.peer(peerId)!;
    const recent = this.store.historyAfter(peerId, peer.notes_until, Number.MAX_SAFE_INTEGER, 200);
    if (
      recent.length < NOTES_MIN_MESSAGES ||
      (recent.length < NOTES_WINDOW &&
        recent.reduce((n, m) => n + estimateTextTokens(renderMessage(m)), 0) <
          this.options.config().contextTokens * NOTES_BUDGET_SHARE)
    )
      return;
    const through = recent[Math.max(0, recent.length - NOTES_TAIL_EXEMPT)].seq;
    if (through > peer.notes_until)
      this.store.enqueue(peerId, 'notes', String(through), { through });
  }
  queueDiary(peerId: string, force = false, now = Date.now()): string | undefined {
    const after = this.store.getSetting<number>(`diary_cursor:${peerId}`, 0);
    const today = dayAt(now, this.options.config().timeZone);
    const records = this.store
      .historyAfter(peerId, after, Number.MAX_SAFE_INTEGER, 200)
      .filter((m) => force || dayAt(m.created_at, this.options.config().timeZone) < today);
    if (!records.length) return;
    const day = dayAt(records[0].created_at, this.options.config().timeZone);
    let chars = 0;
    const picked = [];
    for (const m of records) {
      if (dayAt(m.created_at, this.options.config().timeZone) !== day) break;
      const size = renderMessage(m).length;
      if (picked.length && chars + size > DIARY_MAX_CHARS) break;
      picked.push(m);
      chars += size;
    }
    const through = picked.at(-1)!.seq;
    const id = this.store.enqueue(peerId, 'diary', `${day}:${through}`, {
      day,
      through,
      after,
      ids: picked.map((m) => m.id),
    });
    this.pump();
    return id;
  }
  proactiveAllowed(peer: Peer, now: number, dueLoops = 0): boolean {
    const c = this.options.config(),
      hour = hourAt(now, c.timeZone);
    if (
      !(
        c.proactiveEnabled &&
        !!peer.approved &&
        !!peer.context_token &&
        peer.channel === 'wechat' &&
        peer.last_user_at > 0 &&
        now - peer.last_user_at >= c.proactiveAfterHours * 3600000 &&
        now - peer.last_proactive_at >= 12 * 3600000 &&
        !inQuietHours(hour, c.quietStart, c.quietEnd) &&
        (!peer.last_proactive_at ||
          dayAt(peer.last_proactive_at, c.timeZone) !== dayAt(now, c.timeZone))
      )
    )
      return false;
    // 读空气 brake: unanswered pings stretch the cooldown from hours to days.
    const streak = this.store.unansweredProactiveStreak(peer.id);
    if (streak >= PROACTIVE_IGNORE_LIMIT)
      return now - peer.last_proactive_at >= PROACTIVE_IGNORE_COOLDOWN_DAYS * 86400000;
    // Very low energy means she would not start a conversation at all; this is
    // the mood doing something, not just tinting sentences. A due loop still
    // gets through (loopPingAllowed), because a promise outranks a mood.
    return this.store.mood(peer.id).energy > -0.6;
  }
  /** Which gate a claimed proactive task must pass: loop pings (payload.loop)
   *  use the dedicated due-loop quota, casual pings the daily one. */
  private proactiveGate(task: Task, peer: Peer, now: number): boolean {
    if (typeof task.payload?.loop === 'string')
      return this.loopPingAllowed(peer, now);
    return this.proactiveAllowed(peer, now);
  }
  /** A due open loop may ping even when the daily casual quota is spent —
   *  remembering beats small talk — but quiet hours and the brake still hold. */
  loopPingAllowed(peer: Peer, now: number): boolean {
    const c = this.options.config(),
      hour = hourAt(now, c.timeZone);
    if (
      !(
        c.proactiveEnabled &&
        !!peer.approved &&
        !!peer.context_token &&
        peer.channel === 'wechat' &&
        peer.last_user_at > 0 &&
        !inQuietHours(hour, c.quietStart, c.quietEnd)
      )
    )
      return false;
    const streak = this.store.unansweredProactiveStreak(peer.id);
    if (streak >= PROACTIVE_IGNORE_LIMIT)
      return now - peer.last_proactive_at >= PROACTIVE_IGNORE_COOLDOWN_DAYS * 86400000;
    // Independent of the casual daily quota, but never right after a ping —
    // the due-loop dedupe key makes this a one-shot per loop per day anyway.
    return now - peer.last_proactive_at >= 12 * 3600000;
  }
  schedule(now = Date.now()) {
    if (this.stopped) return;
    const c = this.options.config(),
      hour = hourAt(now, c.timeZone);
    for (const peer of this.store.peers().filter((p) => p.approved)) {
      if (hour >= c.diaryHour) this.queueDiary(peer.id, false, now);
      const casualAllowed = this.proactiveAllowed(peer, now);
      const dueLoops = casualAllowed
        ? []
        : this.store.dueOpenLoops(peer.id, now).filter((l) => !l.asked);
      const loopPing = !casualAllowed && dueLoops.length && this.loopPingAllowed(peer, now);
      if (casualAllowed || loopPing) {
        // Randomized delay so proactive pings do not land at the same minute
        // every day — a small step toward a human-like rhythm.
        const jitter = Math.floor(Math.random() * PROACTIVE_JITTER_MINUTES) * 60000;
        const loop = loopPing ? dueLoops[0] : undefined;
        this.store.enqueue(
          peer.id,
          'proactive',
          // The due date is part of the key: a yearly loop rolled forward must
          // produce a new task instead of hitting last year's finished one.
          loop ? this.store.loopTaskKey(loop) : `casual:${dayAt(now, c.timeZone)}`,
          loop ? { loop: loop.id } : {},
          now + jitter,
        );
      }
    }
    this.pump();
  }
}
