import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cosineSimilarity } from '@atri/llm';
export { createBackup, restoreBackup } from './backup.js';

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
export function hourFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = hourFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    });
    hourFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export type TaskKind = 'chat' | 'notes' | 'diary' | 'proactive';
export type SourceKind = 'message' | 'memory' | 'diary';
export interface Peer {
  id: string;
  channel: string;
  address: string;
  context_token: string;
  approved: number;
  version: number;
  notes: string;
  notes_until: number;
  last_user_at: number;
  last_proactive_at: number;
  created_at: number;
  persona_id: string;
}
export interface Media {
  path?: string;
  mime?: string;
  description?: string;
  kind: string;
  ref?: unknown;
}
export interface Message {
  id: string;
  seq: number;
  peer_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  media: Media[];
  status: string;
  created_at: number;
}
export interface Task {
  id: string;
  peer_id: string;
  kind: TaskKind;
  state: string;
  payload: Record<string, unknown>;
  version: number;
  attempts: number;
  run_at: number;
  error: string;
  created_at: number;
}
export interface Memory {
  id: string;
  peer_id: string;
  content: string;
  kind: 'stated' | 'interpretation';
  sources: string[];
  status: string;
  hits: number;
  last_hit_at: number;
  pinned: number;
  /** When a later fact superseded this one; 0 while still valid. */
  invalid_at: number;
  /** Write-time importance seed (0–1) that scales the ranking score. */
  importance: number;
  created_at: number;
}
/** An unfinished arrangement the user mentioned ("明天面试"): created from a
 *  turn, proactively asked about once due, closed when resolved or expired.
 *  Recurring loops (birthdays, anniversaries) re-open one year later. */
export interface OpenLoop {
  id: string;
  peer_id: string;
  content: string;
  due_at: number;
  due_text: string;
  sources: string[];
  recurring: string;
  asked: number;
  status: string;
  created_at: number;
  resolved_at: number;
}
export interface OpenLoopInput {
  content: string;
  dueAt: number;
  dueText?: string;
  sources: string[];
  recurring?: string;
}
/** Lightweight cross-conversation mood, injected as prose rather than numbers. */
export interface MoodState {
  valence: number;
  energy: number;
  reason?: string;
  at: number;
}
export interface DiarySection {
  id: string;
  peer_id: string;
  day: string;
  content: string;
  sources: string[];
  created_at: number;
}
export interface MemoryUpdate {
  content: string;
  kind: 'stated' | 'interpretation';
  sources: string[];
  supersedes?: string[];
  /** Model's own 0–1 importance for the fact; absent means neutral 0.5. */
  importance?: number;
}
export interface ReplyPart {
  type: 'text' | 'sticker';
  text?: string;
  slug?: string;
  description?: string;
}
export interface Delivery {
  id: string;
  task_id: string;
  peer_id: string;
  ordinal: number;
  part: ReplyPart;
  status: string;
  attempts: number;
  error: string;
  created_at: number;
}
export interface SearchHit {
  id: string;
  kind: SourceKind;
  content: string;
  created_at: number;
  score: number;
  role?: Message['role'];
  memory_kind?: Memory['kind'];
  sources?: string[];
}
export interface EmbeddingVector {
  id: string;
  peer_id: string;
  kind: SourceKind;
  vector: Float32Array;
  dims: number;
  model: string;
}
type Row = Record<string, unknown>;
const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
/** A conservative, provider-independent estimate, not a model tokenizer. */
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** Selection pressure for memory ranking: recency half-life (days) with a floor
 *  so long-lived facts are never evicted by a flood of fresh interpretations,
 *  and how much user-confirmed facts outrank subjective readings. */
export const MEMORY_HALFLIFE_DAYS = 14;
export const MEMORY_RECENCY_FLOOR = 0.35;
export const MEMORY_STATED_WEIGHT = 2.2;
export const MEMORY_INTERPRETATION_WEIGHT = 0.6;
/** Open loops: expire silently after this many days past due. */
export const OPEN_LOOP_EXPIRE_DAYS = 7;
/** Proactive brake: unanswered pings before the cooldown stretches to days. */
export const PROACTIVE_IGNORE_LIMIT = 2;
export const PROACTIVE_IGNORE_COOLDOWN_DAYS = 3;
/** Mood pulses decay toward neutral with these half-lives (hours). Tuned so
 *  "生气" fades overnight and "累" fades within a nap, not a workday. */
export const MOOD_VALENCE_HALFLIFE_HOURS = 12;
export const MOOD_ENERGY_HALFLIFE_HOURS = 4;
/** Usage rollup: keep this many days of per-call rows, older ones aggregate. */
export const USAGE_RETENTION_DAYS = 30;
/** Hard character cap on stored topic notes. */
export const NOTES_MAX_CHARS = 4000;

export class Store {
  readonly sql: DatabaseSync;
  private transactionDepth = 0;
  /** Small per-peer caches keyed by the peers.version change counter. */
  private memoryCache = new Map<string, { version: number; memories: Memory[] }>();
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    if (Number(this.sql.prepare('PRAGMA user_version').get()?.user_version ?? 0) > 4) {
      this.sql.close();
      throw new Error('数据库来自更新版本，不能用当前程序打开');
    }
    const openedAt = Number(
      this.sql.prepare('PRAGMA user_version').get()?.user_version ?? 0,
    );
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, context_token TEXT NOT NULL DEFAULT '',
        approved INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '', notes_until INTEGER NOT NULL DEFAULT 0,
        last_user_at INTEGER NOT NULL DEFAULT 0, last_proactive_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, peer_id TEXT NOT NULL REFERENCES peers(id),
        event_key TEXT, role TEXT NOT NULL, content TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(peer_id,event_key)
      );
      CREATE INDEX IF NOT EXISTS messages_peer ON messages(peer_id,seq);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), kind TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'queued', version INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, run_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        UNIQUE(peer_id,kind,dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS tasks_ready ON tasks(state,run_at,peer_id);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY REFERENCES messages(id), task_id TEXT NOT NULL REFERENCES tasks(id), peer_id TEXT NOT NULL REFERENCES peers(id),
        ordinal INTEGER NOT NULL, part TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(task_id,ordinal)
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), content TEXT NOT NULL, kind TEXT NOT NULL,
        sources TEXT NOT NULL, source_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        UNIQUE(peer_id,source_hash)
      );
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id),
        kind TEXT NOT NULL, vector BLOB NOT NULL, dims INTEGER NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_embeddings_peer ON memory_embeddings(peer_id);
      CREATE TABLE IF NOT EXISTS diary_sections (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        ordinal INTEGER NOT NULL, day TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, UNIQUE(task_id,ordinal)
      );
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, peer_id TEXT, task_id TEXT, purpose TEXT, input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS usage_daily (purpose TEXT NOT NULL, day INTEGER NOT NULL, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, average_ms INTEGER NOT NULL, PRIMARY KEY(purpose,day));
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(id UNINDEXED, peer_id UNINDEXED, kind UNINDEXED, content, created_at UNINDEXED, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS open_loops (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL REFERENCES peers(id), content TEXT NOT NULL,
        due_at INTEGER NOT NULL, due_text TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL,
        recurring TEXT NOT NULL DEFAULT '', asked INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL, resolved_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS open_loops_peer ON open_loops(peer_id,status);
    `);
    if (openedAt < 2) {
      // Pinned memories opt out of decay-based ranking. The big DDL block keeps
      // user_version untouched; only the version that needs the column sets it,
      // so reopening a v2 database (e.g. restored backup) never re-runs this.
      this.sql.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
      this.sql.exec('PRAGMA user_version=2;');
    }
    if (openedAt < 3) {
      // Per-peer persona binding; empty string means "use the default persona".
      this.sql.exec('ALTER TABLE peers ADD COLUMN persona_id TEXT NOT NULL DEFAULT "";');
      this.sql.exec('PRAGMA user_version=3;');
    }
    if (openedAt < 4) {
      // Facts are invalidated, never deleted: invalid_at records when a later
      // statement replaced them, so "she changed her mind" stays traceable.
      // importance is a write-time seed (0–1) that scales ranking; 0.5 is
      // neutral and reproduces the old ordering for existing rows.
      this.sql.exec('ALTER TABLE memories ADD COLUMN invalid_at INTEGER NOT NULL DEFAULT 0;');
      this.sql.exec('ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;');
      this.sql.exec('PRAGMA user_version=4;');
    }
  }
  close() {
    this.sql.close();
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.sql.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }
  getSetting<T>(key: string, fallback: T): T {
    return parse(
      this.sql.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value,
      fallback,
    );
  }
  setSetting(key: string, value: unknown) {
    this.sql
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  removeSetting(key: string) {
    this.sql.prepare('DELETE FROM settings WHERE key=?').run(key);
  }
  ensurePeer(
    id: string,
    channel: string,
    address: string,
    token = '',
    approved = false,
    now = Date.now(),
  ): Peer {
    this.sql
      .prepare(
        `INSERT INTO peers(id,channel,address,context_token,approved,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET context_token=CASE WHEN excluded.context_token<>'' THEN excluded.context_token ELSE peers.context_token END`,
      )
      .run(id, channel, address, token, approved ? 1 : 0, now);
    return this.peer(id)!;
  }
  peer(id: string) {
    return this.sql.prepare('SELECT * FROM peers WHERE id=?').get(id) as unknown as
      Peer | undefined;
  }
  peers() {
    return this.sql
      .prepare('SELECT * FROM peers ORDER BY last_user_at DESC')
      .all() as unknown as Peer[];
  }
  approve(id: string, approved: boolean) {
    this.sql.prepare('UPDATE peers SET approved=? WHERE id=?').run(approved ? 1 : 0, id);
  }
  setPeerPersona(id: string, personaId: string) {
    this.sql
      .prepare('UPDATE peers SET persona_id=? WHERE id=?')
      .run(personaId, id);
  }
  /** Hard-delete a peer and every record tied to it. Messages/media rows keep
   * their files on disk until the next backup prunes orphans; search index,
   * vectors, tasks, outbox and mood settings go too. */
  deletePeer(id: string) {
    this.transaction(() => {
      const tables = [
        'messages',
        'memories',
        'memory_embeddings',
        'diary_sections',
        'open_loops',
        'tasks',
        'outbox',
        'search_index',
        'usage',
      ];
      for (const table of tables)
        this.sql.prepare(`DELETE FROM ${table} WHERE peer_id=?`).run(id);
      this.memoryCache.delete(id);
      for (const key of ['mood', 'diary_cursor'])
        this.removeSetting(`${key}:${id}`);
      // Usage daily aggregates have no peer dimension; leave them (totals only).
      this.sql.prepare('DELETE FROM peers WHERE id=?').run(id);
    });
  }
  private message(row: Row): Message {
    return { ...row, media: parse(row.media, []) } as unknown as Message;
  }
  getMessage(peer: string, id: string) {
    const row = this.sql.prepare('SELECT * FROM messages WHERE peer_id=? AND id=?').get(peer, id);
    return row ? this.message(row) : undefined;
  }
  ingest(
    peer: string,
    eventKey: string,
    content: string,
    media: Media[] = [],
    timestamp = Date.now(),
    /** Only the admin correction path writes anything but a user message. */
    role: 'user' | 'system' = 'user',
  ) {
    return this.transaction(() => {
      const existing = this.sql
        .prepare('SELECT * FROM messages WHERE peer_id=? AND event_key=?')
        .get(peer, eventKey);
      if (existing) return { duplicate: true, message: this.message(existing) };
      const id = randomUUID();
      this.sql
        .prepare(
          'INSERT INTO messages(id,peer_id,event_key,role,content,media,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          peer,
          eventKey,
          role,
          content,
          JSON.stringify(media),
          role === 'system' ? 'note' : 'received',
          timestamp,
        );
      // A system note is not something the user said: it must not move the
      // silence clock that gates proactive contact.
      if (role === 'user')
        this.sql
          .prepare('UPDATE peers SET version=version+1,last_user_at=MAX(last_user_at,?) WHERE id=?')
          .run(timestamp, peer);
      else this.sql.prepare('UPDATE peers SET version=version+1 WHERE id=?').run(peer);
      this.index(id, peer, 'message', content, timestamp);
      return { duplicate: false, message: this.getMessage(peer, id)! };
    });
  }
  updateMedia(peer: string, id: string, media: Media[]) {
    const message = this.getMessage(peer, id);
    if (!message || message.status === 'deleted') return;
    this.sql
      .prepare('UPDATE messages SET media=? WHERE peer_id=? AND id=?')
      .run(JSON.stringify(media), peer, id);
    if (['received', 'sent'].includes(message.status))
      this.index(
        id,
        peer,
        'message',
        message.content +
          media
            .filter((m) => m.description)
            .map((m) => `\n[模型对${m.kind}的观察：${m.description}]`)
            .join(''),
        message.created_at,
      );
  }
  history(peer: string, limit = 40, before = Number.MAX_SAFE_INTEGER): Message[] {
    return this.sql
      .prepare(
        "SELECT * FROM messages WHERE peer_id=? AND seq<=? AND status IN ('received','sent') ORDER BY seq DESC LIMIT ?",
      )
      .all(peer, before, Math.min(500, limit))
      .reverse()
      .map((r) => this.message(r));
  }
  historyAfter(
    peer: string,
    after: number,
    before = Number.MAX_SAFE_INTEGER,
    limit = 200,
  ): Message[] {
    return this.sql
      .prepare(
        "SELECT * FROM messages WHERE peer_id=? AND seq>? AND seq<=? AND status IN ('received','sent') ORDER BY seq LIMIT ?",
      )
      .all(peer, after, before, limit)
      .map((r) => this.message(r));
  }
  enqueue(
    peer: string,
    kind: TaskKind,
    key: string,
    payload: Record<string, unknown> = {},
    runAt = Date.now(),
  ): string {
    const id = randomUUID();
    this.sql
      .prepare(
        'INSERT OR IGNORE INTO tasks(id,peer_id,kind,dedupe_key,payload,run_at,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, peer, kind, key, JSON.stringify(payload), runAt, Date.now());
    // A terminal-but-not-done row (failed/superseded/interrupted) used to
    // swallow every future enqueue with the same dedupe key, which permanently
    // froze that key: notes kept reusing the same `through`, diary the same
    // day, a yearly loop the same id. Reviving it keeps dedupe for in-flight
    // work while letting a later attempt actually run.
    this.sql
      .prepare(
        `UPDATE tasks SET state='queued',payload=?,run_at=?,error='',attempts=0
         WHERE peer_id=? AND kind=? AND dedupe_key=? AND state IN ('failed','superseded','interrupted')`,
      )
      .run(JSON.stringify(payload), runAt, peer, kind, key);
    return String(
      this.sql
        .prepare('SELECT id FROM tasks WHERE peer_id=? AND kind=? AND dedupe_key=?')
        .get(peer, kind, key)!.id,
    );
  }
  enqueueChat(peer: string, seq: number, debounceMs: number) {
    const existing = this.sql
      .prepare(
        "SELECT id FROM tasks WHERE peer_id=? AND kind='chat' AND state='queued' ORDER BY created_at LIMIT 1",
      )
      .get(peer);
    if (existing) {
      this.sql
        .prepare('UPDATE tasks SET payload=?,run_at=? WHERE id=?')
        .run(JSON.stringify({ through: seq }), Date.now() + debounceMs, String(existing.id));
      return String(existing.id);
    }
    return this.enqueue(peer, 'chat', String(seq), { through: seq }, Date.now() + debounceMs);
  }
  private task(row: Row): Task {
    return { ...row, payload: parse(row.payload, {}) } as unknown as Task;
  }
  taskById(id: string) {
    const row = this.sql.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    return row ? this.task(row) : undefined;
  }
  readyPeers(now = Date.now()): string[] {
    return this.sql
      .prepare(
        `SELECT DISTINCT p.id FROM peers p WHERE p.approved=1 AND
      NOT EXISTS(SELECT 1 FROM outbox WHERE peer_id=p.id AND status IN ('uncertain','failed')) AND
      (EXISTS(SELECT 1 FROM tasks WHERE peer_id=p.id AND state='queued' AND run_at<=?) OR EXISTS(SELECT 1 FROM outbox WHERE peer_id=p.id AND status='pending'))`,
      )
      .all(now)
      .map((r) => String(r.id));
  }
  claim(peer: string, now = Date.now()): Task | undefined {
    return this.transaction(() => {
      const row = this.sql
        .prepare(
          `SELECT * FROM tasks WHERE peer_id=? AND state='queued' AND run_at<=? ORDER BY
        CASE kind WHEN 'chat' THEN 0 WHEN 'notes' THEN 1 WHEN 'diary' THEN 2 ELSE 3 END,created_at LIMIT 1`,
        )
        .get(peer, now);
      if (!row) return undefined;
      this.sql
        .prepare("UPDATE tasks SET state='running',version=?,attempts=attempts+1 WHERE id=?")
        .run(this.peer(peer)!.version, String(row.id));
      return this.taskById(String(row.id));
    });
  }
  finish(id: string, state = 'done', error = '') {
    this.sql
      .prepare('UPDATE tasks SET state=?,error=? WHERE id=?')
      .run(state, error.slice(0, 400), id);
  }
  retry(id: string, delay = 0) {
    this.sql
      .prepare(
        "UPDATE tasks SET state='queued',run_at=?,error='' WHERE id=? AND state NOT IN ('done','ready')",
      )
      .run(Date.now() + delay, id);
  }
  recover() {
    this.transaction(() => {
      this.sql.exec(
        "UPDATE tasks SET state='queued' WHERE state='running'; UPDATE outbox SET status='uncertain',error='进程在发送确认前退出，请确认是否送达' WHERE status='sending'; UPDATE messages SET status='uncertain' WHERE id IN (SELECT id FROM outbox WHERE status='uncertain');",
      );
    });
  }
  pendingDeliveries(peer: string): Delivery[] {
    return this.sql
      .prepare(
        "SELECT * FROM outbox WHERE peer_id=? AND status='pending' ORDER BY created_at,task_id,ordinal",
      )
      .all(peer)
      .map((r) => ({ ...r, part: parse(r.part, {}) }) as unknown as Delivery);
  }
  issues() {
    return {
      tasks: this.sql
        .prepare(
          "SELECT t.id,t.peer_id,p.address,t.kind,t.state,t.error,t.created_at FROM tasks t JOIN peers p ON p.id=t.peer_id WHERE t.state='failed' ORDER BY t.created_at DESC LIMIT 100",
        )
        .all(),
      deliveries: this.sql
        .prepare(
          "SELECT o.id,o.peer_id,p.address,o.task_id,o.status,o.error,o.created_at,m.content FROM outbox o JOIN peers p ON p.id=o.peer_id JOIN messages m ON m.id=o.id WHERE o.status IN ('uncertain','failed') ORDER BY o.created_at DESC LIMIT 100",
        )
        .all(),
    };
  }
  saveReply(task: Task, parts: ReplyPart[], updates: MemoryUpdate[], now = Date.now()): boolean {
    return this.transaction(() => {
      if (this.taskById(task.id)?.state !== 'running') return false;
      if (this.peer(task.peer_id)?.version !== task.version) {
        this.finish(task.id, 'superseded');
        return false;
      }
      for (const update of updates) this.writeMemory(task.peer_id, update, now);
      parts.forEach((part, ordinal) => {
        const id = `${task.id}:${ordinal}`;
        const content =
          part.type === 'text' ? part.text! : `[表情：${part.description ?? part.slug}]`;
        this.sql
          .prepare(
            "INSERT INTO messages(id,peer_id,role,content,status,created_at) VALUES(?,?,'assistant',?,'pending',?)",
          )
          .run(id, task.peer_id, content, now);
        this.sql
          .prepare(
            'INSERT INTO outbox(id,task_id,peer_id,ordinal,part,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(id, task.id, task.peer_id, ordinal, JSON.stringify(part), now);
      });
      this.finish(task.id, parts.length ? 'ready' : 'done');
      if (task.kind === 'chat' && typeof task.payload.through === 'number')
        this.sql
          .prepare(
            "UPDATE tasks SET state='superseded' WHERE peer_id=? AND kind='chat' AND id<>? AND state IN ('queued','failed') AND CAST(json_extract(payload,'$.through') AS INTEGER)<=?",
          )
          .run(task.peer_id, task.id, task.payload.through);
      return true;
    });
  }
  startDelivery(id: string) {
    this.sql
      .prepare(
        "UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'",
      )
      .run(id);
  }
  markDelivery(
    id: string,
    status: 'sent' | 'uncertain' | 'failed' | 'pending' | 'cancelled',
    error = '',
    now = Date.now(),
  ) {
    this.transaction(() => {
      const row = this.sql.prepare('SELECT * FROM outbox WHERE id=?').get(id);
      if (!row) throw new Error('发送记录不存在');
      this.sql
        .prepare('UPDATE outbox SET status=?,error=? WHERE id=?')
        .run(status, error.slice(0, 400), id);
      this.sql.prepare('UPDATE messages SET status=? WHERE id=?').run(status, id);
      if (status === 'sent') {
        const msg = this.getMessage(String(row.peer_id), id)!;
        this.index(id, msg.peer_id, 'message', msg.content, msg.created_at);
        if (this.taskById(String(row.task_id))?.kind === 'proactive')
          this.sql.prepare('UPDATE peers SET last_proactive_at=? WHERE id=?').run(now, msg.peer_id);
      }
      const count = Number(
        this.sql
          .prepare(
            "SELECT count(*) AS n FROM outbox WHERE task_id=? AND status NOT IN ('sent','cancelled')",
          )
          .get(String(row.task_id))!.n,
      );
      if (!count) this.finish(String(row.task_id));
    });
  }
  cancelUnsent(task: Task): boolean {
    return this.transaction(() => {
      if (
        this.sql
          .prepare(
            "SELECT 1 FROM outbox WHERE task_id=? AND status IN ('sent','sending','uncertain')",
          )
          .get(task.id)
      )
        return false;
      this.sql
        .prepare("UPDATE outbox SET status='cancelled' WHERE task_id=? AND status='pending'")
        .run(task.id);
      this.sql
        .prepare(
          "UPDATE messages SET status='cancelled' WHERE id IN (SELECT id FROM outbox WHERE task_id=?)",
        )
        .run(task.id);
      this.finish(task.id, 'superseded');
      return true;
    });
  }
  private index(id: string, peer: string, kind: SourceKind, content: string, at: number) {
    this.sql.prepare('DELETE FROM search_index WHERE id=?').run(id);
    // Content changed: the stale vector must not survive the refresh.
    this.sql.prepare('DELETE FROM memory_embeddings WHERE id=?').run(id);
    this.sql
      .prepare('INSERT INTO search_index(id,peer_id,kind,content,created_at) VALUES(?,?,?,?,?)')
      .run(id, peer, kind, content, at);
  }
  private unindex(id: string) {
    this.sql.prepare('DELETE FROM search_index WHERE id=?').run(id);
  }
  private describeHit(hit: SearchHit): SearchHit {
    if (hit.kind === 'message') {
      // Index IDs are globally unique; access scope was checked before this lookup.
      const role = this.sql.prepare('SELECT role FROM messages WHERE id=?').get(hit.id)?.role;
      return { ...hit, role: role as Message['role'] };
    }
    const row =
      hit.kind === 'memory'
        ? this.sql.prepare('SELECT kind,sources FROM memories WHERE id=?').get(hit.id)
        : this.sql.prepare('SELECT sources FROM diary_sections WHERE id=?').get(hit.id);
    return {
      ...hit,
      sources: parse<string[]>(row?.sources, []),
      ...(hit.kind === 'memory' ? { memory_kind: row?.kind as Memory['kind'] } : {}),
    };
  }
  sources(peer: string, ids: string[]): SearchHit[] {
    const rows: SearchHit[] = [];
    for (const id of [...new Set(ids)].slice(0, 40)) {
      const row = this.sql
        .prepare('SELECT id,kind,content,created_at FROM search_index WHERE peer_id=? AND id=?')
        .get(peer, id);
      if (row)
        rows.push(
          this.describeHit({
            ...row,
            created_at: Number(row.created_at),
            score: 1,
          } as unknown as SearchHit),
        );
    }
    return rows;
  }
  memories(peer: string): Memory[] {
    const version = Number(this.sql.prepare('SELECT version FROM peers WHERE id=?').get(peer)?.version ?? -1);
    const cached = this.memoryCache.get(peer);
    if (cached && cached.version === version) return cached.memories;
    // Pinned rows are fetched separately: a lifetime of chat makes the newest
    // 500 a sliding window that would silently drop a pinned memory created
    // long ago, defeating "置顶的记忆永远会带在身边".
    const rows = this.sql
      .prepare(
        `SELECT * FROM memories WHERE peer_id=? AND status='active'
         AND (pinned=1 OR id IN (SELECT id FROM memories WHERE peer_id=? AND status='active' ORDER BY created_at DESC LIMIT 500))
         ORDER BY pinned DESC, created_at DESC`,
      )
      .all(peer, peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as Memory);
    // Bounded cache; setMemoryPinned/correctMemory invalidate explicitly and a
    // version bump covers every write path, so staleness is impossible.
    if (this.memoryCache.size > 64) this.memoryCache.clear();
    this.memoryCache.set(peer, { version, memories: rows });
    return rows;
  }
  setMemoryPinned(peer: string, id: string, pinned: boolean) {
    const result = this.sql
      .prepare("UPDATE memories SET pinned=? WHERE peer_id=? AND id=? AND status='active'")
      .run(pinned ? 1 : 0, peer, id);
    if (!result.changes) throw new Error('记忆不存在');
    this.memoryCache.delete(peer);
  }
  /** Memories ranked by usage, importance and recency for prompt inclusion.
   *  Pinned memories always come first and never participate in the budget
   *  trim that pops from the tail. */
  rankedMemories(peer: string, limit = 10): Memory[] {
    return this.rankedMemoriesScored(peer, limit).map((s) => s.memory);
  }
  /** Same ranking, exposing scores/ages so callers can apply semantic boost. */
  rankedMemoriesScored(peer: string, limit = 10): { memory: Memory; score: number; pinned: boolean }[] {
    const now = Date.now(),
      halflifeMs = MEMORY_HALFLIFE_DAYS * 86400000;
    const scored = this.memories(peer).map((m) => {
      if (m.pinned)
        return { memory: m, score: Number.MAX_SAFE_INTEGER, pinned: true };
      const age = Math.max(0, now - m.created_at);
      const recency = Math.max(
        MEMORY_RECENCY_FLOOR,
        Math.pow(0.5, age / halflifeMs),
      );
      const kindWeight =
        m.kind === 'stated' ? MEMORY_STATED_WEIGHT : MEMORY_INTERPRETATION_WEIGHT;
      const hits = m.hits ?? 0;
      // Importance is a mild multiplier (0.6–1.4 around the neutral 0.5): it
      // nudges the order without letting a single "important" tag bury every
      // recent fact.
      const importance = 0.6 + (Number.isFinite(m.importance) ? m.importance : 0.5) * 0.8;
      return {
        memory: m,
        score: (1 + Math.sqrt(hits)) * recency * kindWeight * importance,
        pinned: false,
      };
    });
    return scored.sort((a, b) => b.score - a.score || b.memory.created_at - a.memory.created_at).slice(0, limit);
  }
  /** Count prompt inclusions per memory so reused memories outrank one-offs. */
  markMemoriesUsed(peer: string, ids: string[], now = Date.now()) {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    const placeholders = unique.map(() => '?').join(',');
    this.sql
      .prepare(
        `UPDATE memories SET hits=hits+1, last_hit_at=? WHERE peer_id=? AND id IN (${placeholders}) AND status=?`,
      )
      .run(now, peer, ...unique, 'active');
    this.memoryCache.delete(peer);
  }
  private writeMemory(peer: string, update: MemoryUpdate, now: number) {
    // Every write path bumps peers.version, but the bump lands before or after
    // this within the same transaction; drop the cache defensively per write.
    this.memoryCache.delete(peer);
    const ids = [...new Set(update.sources)];
    const sources = this.sources(peer, ids);
    if (
      !update.content.trim() ||
      !ids.length ||
      ids.length !== sources.length ||
      sources.some((s) => s.kind === 'memory')
    )
      return;
    if (update.kind === 'stated' && sources.some((s) => s.kind === 'diary')) return;
    // "Stated" means the user confirmed it. A memory sourced only from the
    // assistant's own text lets a guess become a user fact. Admin corrections
    // arrive as system notes, which are deliberate user-side evidence.
    if (
      update.kind === 'stated' &&
      !sources.some(
        (s) => s.kind === 'message' && (s.role === 'user' || s.role === 'system'),
      )
    )
      return;
    const content = update.content.trim();
    const sourceHash = hash(content + '\n' + ids.sort().join(','));
    // Identical wording from a different turn is the same fact; only extend
    // its evidence instead of storing a duplicate row.
    const duplicate = this.sql
      .prepare(
        "SELECT id,sources FROM memories WHERE peer_id=? AND content=? AND status='active' LIMIT 1",
      )
      .get(peer, content.slice(0, 800)) as Row | undefined;
    if (duplicate) {
      const merged = [...new Set([...parse<string[]>(duplicate.sources, []), ...ids])].slice(0, 20);
      this.sql
        .prepare('UPDATE memories SET sources=?,importance=MAX(importance,?) WHERE id=?')
        .run(JSON.stringify(merged), update.importance ?? 0.5, String(duplicate.id));
      this.memoryCache.delete(peer);
      return;
    }
    const id = randomUUID();
    const result = this.sql
      .prepare(
        'INSERT OR IGNORE INTO memories(id,peer_id,content,kind,sources,source_hash,importance,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        peer,
        content.slice(0, 800),
        update.kind,
        JSON.stringify(ids),
        sourceHash,
        Math.max(0, Math.min(1, update.importance ?? 0.5)),
        now,
      );
    if (!result.changes) return;
    for (const previous of update.supersedes ?? []) {
      // Invalidate rather than delete: the old row leaves default recall but
      // keeps its text and the moment it stopped being true.
      if (
        this.sql
          .prepare(
            "UPDATE memories SET status='superseded',invalid_at=? WHERE peer_id=? AND id=? AND status='active'",
          )
          .run(now, peer, previous).changes
      )
        this.unindex(previous);
    }
    this.index(id, peer, 'memory', content.slice(0, 800), now);
  }
  addMemory(peer: string, update: MemoryUpdate, expectedVersion: number) {
    return this.transaction(() => {
      if (this.peer(peer)?.version !== expectedVersion) return false;
      this.writeMemory(peer, update, Date.now());
      return true;
    });
  }
  correctMemory(peer: string, id: string, content: string) {
    this.transaction(() => {
      const original = this.sql
        .prepare(
          "SELECT id,hits,last_hit_at,pinned FROM memories WHERE peer_id=? AND id=? AND status='active'",
        )
        .get(peer, id) as Row | undefined;
      if (!original) throw new Error('记忆不存在');
      // The correction is evidence in its own right, but it must not masquerade
      // as a user message: `ingest` writes role='user' and refreshes
      // last_user_at, which would reset the proactive silence clock and show
      // up in history as if the user had said it.
      const msg = this.ingest(peer, randomUUID(), `[管理页更正] ${content}`, [], Date.now(), 'system')
        .message;
      const carried = {
        hits: Number(original.hits ?? 0),
        at: Number(original.last_hit_at ?? 0),
        pinned: Number(original.pinned ?? 0),
      };
      this.writeMemory(
        peer,
        { content, kind: 'stated', sources: [msg.id], supersedes: [id] },
        Date.now(),
      );
      const newest = this.sql
        .prepare(
          "SELECT id FROM memories WHERE peer_id=? AND content=? AND status='active' ORDER BY created_at DESC LIMIT 1",
        )
        .get(peer, content.slice(0, 800)) as Row | undefined;
      if (newest)
        this.sql
          .prepare('UPDATE memories SET hits=?,last_hit_at=?,pinned=? WHERE id=?')
          .run(carried.hits, carried.at, carried.pinned, String(newest.id));
      this.sql.prepare("UPDATE peers SET notes='',notes_until=0 WHERE id=?").run(peer);
    });
  }
  diaries(peer: string): DiarySection[] {
    return this.sql
      .prepare(
        "SELECT * FROM diary_sections WHERE peer_id=? AND status='active' ORDER BY day DESC,created_at,ordinal LIMIT 500",
      )
      .all(peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as DiarySection);
  }
  saveDiary(
    task: Task,
    day: string,
    sections: { content: string; sources: string[] }[],
    updates: MemoryUpdate[],
    now = Date.now(),
  ) {
    this.transaction(() => {
      if (this.taskById(task.id)?.state !== 'running') return;
      sections.forEach((section, ordinal) => {
        const sources = this.sources(task.peer_id, section.sources);
        if (
          !section.sources.length ||
          sources.length !== new Set(section.sources).size ||
          sources.some((s) => s.kind !== 'message')
        )
          return;
        const id = `diary:${task.id}:${ordinal}`;
        this.sql
          .prepare(
            'INSERT OR IGNORE INTO diary_sections(id,peer_id,task_id,ordinal,day,content,sources,created_at) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            task.peer_id,
            task.id,
            ordinal,
            day,
            section.content,
            JSON.stringify(section.sources),
            now,
          );
        this.index(id, task.peer_id, 'diary', section.content, now);
      });
      if (this.peer(task.peer_id)?.version === task.version)
        for (const update of updates) this.writeMemory(task.peer_id, update, now);
      if (typeof task.payload.through === 'number')
        this.setSetting(`diary_cursor:${task.peer_id}`, task.payload.through);
      this.finish(task.id);
    });
  }
  setNotes(task: Task, notes: string, through: number) {
    this.transaction(() => {
      if (this.peer(task.peer_id)?.version === task.version)
        this.sql
          .prepare('UPDATE peers SET notes=?,notes_until=? WHERE id=?')
          .run(notes.slice(0, NOTES_MAX_CHARS), through, task.peer_id);
      this.finish(task.id);
    });
  }
  forget(peer: string, id: string) {
    this.transaction(() => {
      this.memoryCache.delete(peer);
      const source = this.sources(peer, [id])[0];
      if (!source) throw new Error('记录不存在');
      if (source.kind === 'message')
        this.sql
          .prepare(
            "UPDATE messages SET content='',media='[]',status='deleted' WHERE peer_id=? AND id=?",
          )
          .run(peer, id);
      if (source.kind === 'memory')
        this.sql
          .prepare("UPDATE memories SET content='',status='deleted' WHERE peer_id=? AND id=?")
          .run(peer, id);
      const invalid = new Set([id]);
      // Invalidation must cover the entire history, independent of UI list limits.
      const diaries = this.sql
        .prepare("SELECT id,sources FROM diary_sections WHERE peer_id=? AND status='active'")
        .all(peer)
        .map((r) => ({ id: String(r.id), sources: parse<string[]>(r.sources, []) }));
      for (const diary of diaries)
        if (diary.id === id || diary.sources.some((s) => invalid.has(s))) {
          invalid.add(diary.id);
          this.sql
            .prepare("UPDATE diary_sections SET content='',status='deleted' WHERE id=?")
            .run(diary.id);
        }
      const memories = this.sql
        .prepare("SELECT id,sources FROM memories WHERE peer_id=? AND status='active'")
        .all(peer)
        .map((r) => ({ id: String(r.id), sources: parse<string[]>(r.sources, []) }));
      for (const mem of memories)
        if (mem.sources.some((s) => invalid.has(s))) {
          invalid.add(mem.id);
          this.sql
            .prepare("UPDATE memories SET content='',status='deleted' WHERE id=?")
            .run(mem.id);
        }
      for (const sourceId of invalid) this.unindex(sourceId);
      this.dropEmbeddings(peer, [...invalid]);
      this.sql
        .prepare("UPDATE peers SET notes='',notes_until=0,version=version+1 WHERE id=?")
        .run(peer);
    });
  }
  /** Rows needing embedding: indexed, not yet vectorized, newest first. */
  pendingEmbeddings(peer: string, limit = 64): { id: string; kind: SourceKind; content: string; created_at: number }[] {
    return this.sql
      .prepare(
        `SELECT s.id,s.kind,s.content,s.created_at FROM search_index s
       LEFT JOIN memory_embeddings e ON e.id=s.id
       WHERE s.peer_id=? AND e.id IS NULL
       ORDER BY s.created_at DESC LIMIT ?`,
      )
      .all(peer, limit)
      .map((r) => ({
        id: String(r.id),
        kind: String(r.kind) as SourceKind,
        content: String(r.content),
        created_at: Number(r.created_at),
      }));
  }
  search(peer: string, query: string, limit = 6, kind?: SourceKind, queryVector?: Float32Array): SearchHit[] {
    const normalized = query.normalize('NFKC').toLowerCase();
    const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
    const terms = [
      ...new Set(
        words.flatMap((w) =>
          /\p{Script=Han}/u.test(w)
            ? [w, ...Array.from({ length: Math.max(0, w.length - 1) }, (_, i) => w.slice(i, i + 2))]
            : [w],
        ),
      ),
    ]
      .filter((t) => t.length >= 2)
      .slice(0, 48);
    if (!terms.length && normalized.trim()) terms.push(normalized.trim());
    if (!terms.length) return [];
    const rows: Row[] = [];
    const kindClause = kind ? ' AND kind=?' : '',
      kindParameters = kind ? [kind] : [];
    const longTerms = terms.filter((t) => [...t].length >= 3).slice(0, 20);
    if (longTerms.length) {
      const match = longTerms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
      rows.push(
        ...this.sql
          .prepare(
            'SELECT id,kind,content,created_at FROM search_index WHERE peer_id=? AND search_index MATCH ?' +
              kindClause +
              ' ORDER BY rank LIMIT 150',
          )
          .all(peer, match, ...kindParameters),
      );
    }
    // LIKE scan only when FTS came up short — it is the fallback for short
    // Chinese bigrams, not a duplicate pass over the same hits.
    if (rows.length < 20) {
      const likeTerms = terms.slice(0, 32).map((t) => '%' + t.replace(/[\\%_]/g, '\\$&') + '%');
      rows.push(
        ...this.sql
          .prepare(
            `SELECT id,kind,content,created_at FROM search_index WHERE peer_id=? AND (${likeTerms.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ')})${kindClause} ORDER BY CAST(created_at AS INTEGER) DESC LIMIT 300`,
          )
          .all(peer, ...likeTerms, ...kindParameters),
      );
    }
    // Semantic candidates: rows that share no surface form with the query but
    // are stored vectors — the whole point of hybrid retrieval. Vector scan is
    // capped: recency-weighted slice keeps the cost bounded on long histories.
    if (queryVector) {
      rows.push(
        ...this.sql
          .prepare(
            `SELECT s.id,s.kind,s.content,s.created_at FROM memory_embeddings e JOIN search_index s ON s.id=e.id
           WHERE e.peer_id=? ${kind ? 'AND s.kind=?' : ''}
           ORDER BY s.created_at DESC LIMIT 2000`,
          )
          .all(peer, ...(kind ? [kind] : []))
          .map((r) => r as Row),
      );
    }
    // One query for every vector instead of a prepare+get per row: the result
    // set reaches 2000 rows when vectors are on, and that used to be 2000
    // round trips inside a reply.
    const vectors = new Map<string, Float32Array>();
    if (queryVector) {
      const ids = [...new Set(rows.map((r) => String(r.id)))];
      for (let i = 0; i < ids.length; i += 400) {
        const slice = ids.slice(i, i + 400);
        for (const row of this.sql
          .prepare(
            `SELECT id,vector FROM memory_embeddings WHERE id IN (${slice.map(() => '?').join(',')})`,
          )
          .all(...slice) as Row[]) {
          const buf = row.vector as Buffer;
          vectors.set(
            String(row.id),
            new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
          );
        }
      }
    }
    const now = Date.now();
    const scored = [...new Map(rows.map((r) => [r.id, r])).values()]
      .filter((r) => !kind || r.kind === kind)
      .map((r) => {
        const body = String(r.content).normalize('NFKC').toLowerCase();
        const lexical = terms.reduce((n, t) => n + (body.includes(t) ? Math.min(t.length, 8) : 0), 0);
        const vector = vectors.get(String(r.id));
        const semantic = queryVector && vector ? Math.max(0, cosineSimilarity(queryVector, vector)) : 0;
        // Recency boost applies only to genuine matches: without the similarity
        // floor a fresh-but-irrelevant row would outrank an old exact hit.
        const ageDays = Math.max(0, now - Number(r.created_at)) / 86400000;
        const boost =
          semantic >= 0.35 || lexical > 0
            ? 1 + 0.2 * Math.pow(0.5, ageDays / MEMORY_HALFLIFE_DAYS)
            : 1;
        const base = lexical + semantic * 4;
        const kindBonus = lexical ? (r.kind === 'memory' ? 0.5 : r.kind === 'diary' ? 0.25 : 0) : 0;
        return {
          row: r,
          created_at: Number(r.created_at),
          score: (base + kindBonus) * boost,
          vector,
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.created_at - a.created_at);
    // MMR keeps the top-k from being one topic repeated: pick the best hit,
    // then penalise candidates too similar to what is already chosen.
    const picked: typeof scored = [];
    const candidates = [...scored];
    const cap = Math.max(1, Math.min(limit, 20));
    while (picked.length < cap && candidates.length) {
      let best = 0,
        bestScore = -Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        let penalty = 0;
        for (const chosen of picked) {
          if (chosen.vector && candidate.vector)
            penalty = Math.max(penalty, cosineSimilarity(chosen.vector, candidate.vector));
          else if (chosen.row.content === candidate.row.content) penalty = 1;
        }
        // λ=0.7: relevance still leads, redundancy only breaks near-ties.
        const value = 0.7 * candidate.score - 0.3 * penalty;
        if (value > bestScore) {
          bestScore = value;
          best = i;
        }
      }
      picked.push(candidates.splice(best, 1)[0]!);
    }
    return picked.map((p) => this.describeHit({ ...p.row, score: p.score } as unknown as SearchHit));
  }
  openLoops(peer: string, onlyOpen = false): OpenLoop[] {
    return this.sql
      .prepare(
        `SELECT * FROM open_loops WHERE peer_id=? ${onlyOpen ? "AND status='open'" : ''} ORDER BY due_at LIMIT 100`,
      )
      .all(peer)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as OpenLoop);
  }
  /** Due loops: fallen due, not yet asked about, still inside the ask window. */
  dueOpenLoops(peer: string, now = Date.now()): OpenLoop[] {
    return this.sql
      .prepare(
        `SELECT * FROM open_loops WHERE peer_id=? AND status='open' AND asked=0
         AND due_at<=? AND due_at>? ORDER BY due_at`,
      )
      .all(peer, now, now - OPEN_LOOP_EXPIRE_DAYS * 86400000)
      .map((r) => ({ ...r, sources: parse(r.sources, []) }) as unknown as OpenLoop);
  }
  addOpenLoop(peer: string, input: OpenLoopInput, now = Date.now()): OpenLoop {
    const content = input.content.slice(0, 300);
    // The same plan is often re-extracted on the next turn ("我明天面试" comes
    // up twice); storing it again would create duplicate reminders.
    const existing = this.sql
      .prepare(
        "SELECT * FROM open_loops WHERE peer_id=? AND status='open' AND content=? AND ABS(due_at-?)<3600000 ORDER BY created_at LIMIT 1",
      )
      .get(peer, content, input.dueAt) as Row | undefined;
    if (existing) {
      // Same plan, maybe with a better due time or one more source: merge.
      const sources = [...new Set([...parse<string[]>(existing.sources, []), ...input.sources])].slice(0, 10);
      this.sql
        .prepare('UPDATE open_loops SET due_at=?,due_text=?,sources=? WHERE id=?')
        .run(input.dueAt, input.dueText ?? String(existing.due_text ?? ''), JSON.stringify(sources), String(existing.id));
      return this.openLoops(peer).find((l) => l.id === String(existing.id))!;
    }
    const id = randomUUID();
    this.sql
      .prepare(
        'INSERT INTO open_loops(id,peer_id,content,due_at,due_text,sources,recurring,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        peer,
        content,
        input.dueAt,
        input.dueText ?? '',
        JSON.stringify([...new Set(input.sources)].slice(0, 10)),
        input.recurring === 'yearly' ? 'yearly' : '',
        now,
      );
    return this.openLoops(peer).find((l) => l.id === id)!;
  }
  /** The user answered about this arrangement: close it quietly. Recurring
   *  loops instead move to next year — a birthday never "resolves". Because a
   *  yearly loop rolls in place, `loopTaskKey` includes the new due date so a
   *  fresh ping is not swallowed by the previous year's finished task. */
  resolveOpenLoop(peer: string, id: string, now = Date.now()) {
    const loop = this.sql
      .prepare("SELECT recurring,due_at FROM open_loops WHERE peer_id=? AND id=? AND status='open'")
      .get(peer, id) as Row | undefined;
    if (!loop) return;
    if (String(loop.recurring) === 'yearly') {
      const next = Number(loop.due_at) + 365 * 86400000;
      this.sql
        .prepare("UPDATE open_loops SET due_at=?,asked=0 WHERE peer_id=? AND id=?")
        .run(next, peer, id);
      return;
    }
    this.sql
      .prepare(
        "UPDATE open_loops SET status='resolved',resolved_at=? WHERE peer_id=? AND id=? AND status='open'",
      )
      .run(now, peer, id);
  }
  /** Dedupe key for a loop ping; the due date makes each yearly roll distinct. */
  loopTaskKey(loop: { id: string; due_at: number }): string {
    return `loop:${loop.id}:${loop.due_at}`;
  }
  markLoopAsked(peer: string, id: string, now = Date.now()) {
    this.sql
      .prepare("UPDATE open_loops SET asked=1 WHERE peer_id=? AND id=? AND status='open'")
      .run(peer, id);
  }
  /** Old loops nobody resolved: drop silently rather than nag about them. */
  expireOpenLoops(peer: string, now = Date.now()) {
    this.sql
      .prepare(
        "UPDATE open_loops SET status='expired' WHERE peer_id=? AND status='open' AND due_at<=?",
      )
      .run(peer, now - OPEN_LOOP_EXPIRE_DAYS * 86400000);
  }
  mood(peer: string): MoodState {
    const raw = this.getSetting<Partial<MoodState> | undefined>(`mood:${peer}`, undefined);
    if (!raw || typeof raw.valence !== 'number' || typeof raw.energy !== 'number') {
      return { valence: 0, energy: 0, at: 0 };
    }
    const at = Number(raw.at ?? 0);
    // Decay toward neutral while offline; both axes never cross zero.
    const decay = (v: number, halflifeHours: number) =>
      Math.abs(v) * Math.pow(0.5, Math.max(0, Date.now() - at) / (halflifeHours * 3600000));
    return {
      valence: decay(raw.valence, MOOD_VALENCE_HALFLIFE_HOURS) * Math.sign(raw.valence),
      // Energy is bipolar too: a tired pulse must stay negative, otherwise the
      // prose hint flips "有点累了" into "精力挺足".
      energy: decay(raw.energy, MOOD_ENERGY_HALFLIFE_HOURS) * Math.sign(raw.energy),
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      at,
    };
  }
  pulseMood(peer: string, delta: Partial<Omit<MoodState, 'at'>>, now = Date.now()) {
    const current = this.mood(peer);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    this.setSetting(`mood:${peer}`, {
      valence: clamp((delta.valence ?? 0) + current.valence),
      energy: clamp((delta.energy ?? 0) + current.energy),
      reason: delta.reason ?? current.reason,
      at: now,
    });
  }
  /** Rule-based mood pulse from one exchange. Deliberately coarse: this feeds
   *  prose tone hints, not a numeric persona. Night and long silences lower
   *  energy; gratitude, laughter and long engaged talks lift valence. */
  pulseMoodFromExchange(
    peer: string,
    exchange: { user: string; assistant: string; userAt: number },
    now = Date.now(),
    timeZone = 'Asia/Shanghai',
  ) {
    const hour = Number(hourFormatter(timeZone).format(new Date(exchange.userAt)));
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    let valence = 0,
      energy = 0,
      reason: string | undefined;
    if (/(谢谢|感谢|辛苦|有你真好|开心|哈哈哈|笑死)/.test(exchange.user)) {
      valence = 0.2;
      reason = /(谢谢|感谢|辛苦)/.test(exchange.user) ? '对方表达了感谢' : '聊得挺开心';
    } else if (/(烦|难过|累|生气|委屈|难受|不开心|压力)/.test(exchange.user)) {
      valence = -0.3;
      reason = '对方提到了不开心的事';
      energy = -0.2;
    } else if (/(晚安|睡了)/.test(exchange.user) || (hour >= 1 && hour < 7)) {
      energy = -0.15;
    } else if (exchange.user.length > 80 && exchange.assistant.length > 80) {
      energy = 0.1;
    }
    if (valence === 0 && energy === 0) return;
    this.pulseMood(peer, { valence, energy, reason }, now);
  }
  /** Per-hour message frequency over the trailing two weeks, for rhythm hints. */
  activityRhythm(peer: string, timeZone: string): number[] {
    const buckets = new Array(24).fill(0) as number[];
    const since = Date.now() - 14 * 86400000;
    const rows = this.sql
      .prepare(
        "SELECT created_at FROM messages WHERE peer_id=? AND role='user' AND status='received' AND created_at>=?",
      )
      .all(peer, since);
    const formatter = hourFormatter(timeZone);
    for (const row of rows) buckets[Number(formatter.format(new Date(Number(row.created_at))))]++;
    return buckets;
  }
  /** Opening lines of proactive messages since `since`, newest first. Used to
   *  keep the same hook from resurfacing two days in a row. */
  proactiveHooks(peer: string, since: number): string[] {
    return (
      this.sql
        .prepare(
          `SELECT m.content FROM outbox o JOIN messages m ON m.id=o.id
           WHERE o.peer_id=? AND o.status='sent' AND m.created_at>=?
             AND o.task_id IN (SELECT id FROM tasks WHERE kind='proactive')
           ORDER BY m.created_at DESC LIMIT 12`,
        )
        .all(peer, since) as Row[]
    )
      .map((r) => String(r.content).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }
  /** Proactive brake: pings sent after the last user message got no reply. */
  unansweredProactiveStreak(peer: string): number {    const lastUser = this.sql
      .prepare("SELECT created_at FROM messages WHERE peer_id=? AND role='user' AND status='received' ORDER BY seq DESC LIMIT 1")
      .get(peer) as Row | undefined;
    const lastUserAt = lastUser ? Number(lastUser.created_at) : 0;
    const rows = this.sql
      .prepare(
        `SELECT m.created_at FROM outbox o JOIN messages m ON m.id=o.id
         WHERE o.peer_id=? AND o.status='sent' AND o.task_id IN (SELECT id FROM tasks WHERE kind='proactive')
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(peer, PROACTIVE_IGNORE_LIMIT) as Row[];
    let streak = 0;
    for (const row of rows) {
      if (Number(row.created_at) < lastUserAt) break;
      streak++;
    }
    return streak;
  }
  recordUsage(
    peer: string,
    task: string,
    purpose: string,
    input: number,
    output: number,
    duration: number,
  ) {
    this.transaction(() => {
      this.sql
        .prepare(
          'INSERT INTO usage(peer_id,task_id,purpose,input_tokens,output_tokens,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(peer, task, purpose, input, output, duration, Date.now());
      // Roll up rows older than the retention window into per-day summaries so
      // the status endpoint never aggregates an ever-growing table.
      const cutoff = Date.now() - USAGE_RETENTION_DAYS * 86400000;
      const stale = this.sql
        .prepare(
          'SELECT purpose,created_at,count(*) AS n,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,round(avg(duration_ms)) AS average_ms FROM usage WHERE created_at<? GROUP BY purpose,created_at/86400000',
        )
        .all(cutoff) as Row[];
      if (stale.length) {
        const upsert = this.sql.prepare(
          'INSERT INTO usage_daily(purpose,day,calls,input_tokens,output_tokens,average_ms) VALUES(?,?,?,?,?,?) ' +
            'ON CONFLICT(purpose,day) DO UPDATE SET calls=calls+excluded.calls,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,average_ms=excluded.average_ms',
        );
        for (const row of stale) {
          upsert.run(
            String(row.purpose),
            Math.floor(Number(row.created_at) / 86400000),
            Number(row.n),
            Number(row.input_tokens),
            Number(row.output_tokens),
            Number(row.average_ms),
          );
        }
        this.sql.prepare('DELETE FROM usage WHERE created_at<?').run(cutoff);
      }
    });
  }
  usage() {
    const recent = this.sql
      .prepare(
        'SELECT purpose,count(*) AS calls,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,round(avg(duration_ms)) AS average_ms FROM usage GROUP BY purpose',
      )
      .all() as Row[];
    const archived = this.sql
      .prepare(
        'SELECT purpose,sum(calls) AS calls,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,0 AS average_ms FROM usage_daily GROUP BY purpose',
      )
      .all() as Row[];
    const merged = new Map<string, Row>();
    for (const row of [...recent, ...archived]) {
      const prior = merged.get(String(row.purpose));
      merged.set(String(row.purpose), prior
        ? {
            purpose: row.purpose,
            calls: Number(prior.calls) + Number(row.calls),
            input_tokens: Number(prior.input_tokens) + Number(row.input_tokens),
            output_tokens: Number(prior.output_tokens) + Number(row.output_tokens),
            average_ms: Number(row.average_ms) || Number(prior.average_ms),
          }
        : row);
    }
    return [...merged.values()];
  }
  recentUsage() {
    return this.sql
      .prepare(
        'SELECT u.purpose,u.input_tokens,u.output_tokens,u.duration_ms,u.created_at,p.address FROM usage u LEFT JOIN peers p ON p.id=u.peer_id ORDER BY u.id DESC LIMIT 12',
      )
      .all();
  }
  setEmbedding(id: string, peer: string, kind: SourceKind, vector: Float32Array, model: string, now = Date.now()) {
    this.sql
      .prepare(
        'INSERT INTO memory_embeddings(id,peer_id,kind,vector,dims,model,created_at) VALUES(?,?,?,?,?,?,?) ' +
          'ON CONFLICT(id) DO UPDATE SET vector=excluded.vector,dims=excluded.dims,model=excluded.model,created_at=excluded.created_at',
      )
      .run(id, peer, kind, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), vector.length, model, now);
  }
  setEmbeddings(items: { id: string; peer: string; kind: SourceKind; vector: Float32Array; model: string }[], now = Date.now()) {
    this.transaction(() => {
      for (const item of items) this.setEmbedding(item.id, item.peer, item.kind, item.vector, item.model, now);
    });
  }
  embeddings(peer: string): EmbeddingVector[] {
    return this.sql
      .prepare('SELECT id,peer_id,kind,vector,dims,model FROM memory_embeddings WHERE peer_id=?')
      .all(peer)
      .map((r) => ({
        id: String(r.id),
        peer_id: String(r.peer_id),
        kind: String(r.kind) as SourceKind,
        vector: new Float32Array(
          (r.vector as Buffer).buffer.slice(
            (r.vector as Buffer).byteOffset,
            (r.vector as Buffer).byteOffset + (r.vector as Buffer).byteLength,
          ),
        ),
        dims: Number(r.dims),
        model: String(r.model),
      }));
  }
  embeddingStatus(): { count: number; models: string[] } {
    const rows = this.sql
      .prepare('SELECT model,count(*) AS n FROM memory_embeddings GROUP BY model')
      .all();
    return {
      count: rows.reduce((sum, r) => sum + Number(r.n), 0),
      models: rows.map((r) => String(r.model)),
    };
  }
  dropEmbeddings(peer: string, ids?: string[]) {
    if (ids) {
      const del = this.sql.prepare('DELETE FROM memory_embeddings WHERE peer_id=? AND id=?');
      this.transaction(() => {
        for (const id of [...new Set(ids)]) del.run(peer, id);
      });
    } else this.sql.prepare('DELETE FROM memory_embeddings WHERE peer_id=?').run(peer);
  }
  async backup(destination: string) {
    mkdirSync(dirname(destination), { recursive: true });
    await backup(this.sql, destination);
  }
}
