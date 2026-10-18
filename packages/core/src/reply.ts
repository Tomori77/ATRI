import type { MemoryUpdate, OpenLoopInput, ReplyPart } from '@atri/db';
import {
  MAX_REPLY_PARTS,
  MAX_MEMORY_UPDATES,
  MAX_IMAGE_DESCRIPTIONS,
  OPEN_LOOP_PROMPT_MAX,
} from './constants.js';
export interface Sticker {
  slug: string;
  description: string;
  tags: string[];
  file: string;
}
export interface ParsedReply {
  parts: ReplyPart[];
  memories: MemoryUpdate[];
  descriptions: { messageId: string; description: string }[];
  /** Arrangements to remember and ask about later ("明天面试"). */
  openLoops: OpenLoopInput[];
  /** Loop IDs the user just answered, closing them. */
  resolveLoops: string[];
  /** Loop IDs this reply actually brought up, so only those are marked asked. */
  askedLoops: string[];
  /** Optional self-assessed mood pulse for this exchange. */
  moodPulse?: { valence: number; energy: number; reason?: string };
  /** Memory IDs included in this turn's prompt; the runtime marks them used. */
  pickedMemoryIds?: string[];
}
export function parseJson(text: string): any {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{'),
      end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('模型输出不是有效 JSON');
  }
}
export function parseMemories(value: unknown): MemoryUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_MEMORY_UPDATES).flatMap((v) => {
    if (
      !v ||
      typeof v.content !== 'string' ||
      !Array.isArray(v.sources) ||
      !['stated', 'interpretation'].includes(v.kind)
    )
      return [];
    return [
      {
        content: v.content.slice(0, 800),
        kind: v.kind,
        sources: v.sources.filter((s: unknown) => typeof s === 'string').slice(0, 20),
        supersedes: Array.isArray(v.supersedes)
          ? v.supersedes.filter((s: unknown) => typeof s === 'string').slice(0, 12)
          : [],
        ...(typeof v.importance === 'number' && Number.isFinite(v.importance)
          ? { importance: Math.max(0, Math.min(1, v.importance)) }
          : {}),
      },
    ];
  });
}
/**
 * Models copy the "[表情：x]" rendering they see in history instead of emitting
 * the JSON sticker object. Match such text against the catalog by slug first,
 * then by description/tag words, and convert hits into real sticker parts.
 */
export function extractInlineStickers(
  text: string,
  stickers: Sticker[],
): { parts: ReplyPart[]; text: string } {
  const parts: ReplyPart[] = [];
  const cleaned = text
    .replace(/(\s*)\[表情[：:]\s*([^\]】]+?)\s*[\]】](\s*)/g, (_all, before: string, name: string, after: string) => {
      const query = name.trim().toLowerCase();
      if (!query) return before;
      const bySlug = stickers.find((s) => s.slug.toLowerCase() === query);
      const byDescription = stickers.find(
        (s) =>
          s.description.toLowerCase().includes(query) ||
          (s.tags ?? []).some((t) => t.toLowerCase() === query),
      );
      const byTag = stickers.find((s) =>
        (s.tags ?? []).some((t) => query.includes(t.toLowerCase()) || t.toLowerCase().includes(query)),
      );
      const sticker = bySlug ?? byDescription ?? byTag;
      if (sticker) {
        parts.push({ type: 'sticker', slug: sticker.slug, description: sticker.description });
        // Keep one separator when text continues on both sides.
        return before && after ? ' ' : '';
      }
      // Unmatched: drop the pseudo-protocol rather than leak it to the chat.
      return before;
    })
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { parts, text: cleaned };
}
/**
 * Models sometimes copy the "[来源 id | time]" annotation from rendered history
 * into their output. Strip leading annotation lines, and when one text blob
 * carries several of them, split it back into separate bubbles the way the
 * model was supposed to emit them via the messages array.
 */
export function stripSourceAnnotations(
  text: string,
): { parts: ReplyPart[]; text: string } {
  const withoutPrefix = text.replace(/^\s*\[来源[^\]]*\]\s*\n?/g, '');
  if (withoutPrefix === text) return { parts: [], text };
  const chunks = withoutPrefix
    .split(/\s*\[来源[^\]]*\]\s*/g)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length <= 1) return { parts: [], text: withoutPrefix.trim() };
  return {
    parts: chunks.slice(0, MAX_REPLY_PARTS).map((c) => ({ type: 'text' as const, text: c })),
    text: '',
  };
}
function normalizeTextParts(
  raw: unknown[],
  stickers: Sticker[],
): ReplyPart[] {
  return raw.slice(0, MAX_REPLY_PARTS).flatMap((m: unknown) => {
    if (typeof m === 'string' && m.trim()) {
      const head = stripSourceAnnotations(m);
      const segments = head.parts.length
        ? head.parts.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : []))
        : [head.text];
      return segments.flatMap((segment) => {
        const { parts, text } = extractInlineStickers(segment, stickers);
        const body = text.trim();
        const stripped = stripSourceAnnotations(body);
        const combined = [...parts, ...stripped.parts];
        if (combined.length) return [...combined, ...(stripped.text ? [{ type: 'text' as const, text: stripped.text.slice(0, 6000) }] : [])];
        if (stripped.text) return [{ type: 'text', text: stripped.text.slice(0, 6000) }];
        return [];
      });
    }
    if (m && typeof m === 'object' && 'type' in m && m.type === 'sticker' && 'slug' in m) {
      const sticker = stickers.find((s) => s.slug === m.slug);
      if (sticker)
        return [{ type: 'sticker', slug: sticker.slug, description: sticker.description }];
    }
    return [];
  });
}
/** Open-loop entries from the model: content plus a due time. When `available`
 *  is given, every source ID must be visible this turn; without it (final JSON
 *  parsing inside the tool loop) only the shape is validated. `due` accepts a
 *  millisecond timestamp or a local-time string resolved by `resolveDue`. */
export function parseOpenLoops(
  value: unknown,
  available?: Set<string>,
  now = Date.now(),
  timeZone = 'Asia/Shanghai',
): OpenLoopInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, OPEN_LOOP_PROMPT_MAX).flatMap((v) => {
    if (!v || typeof v.content !== 'string' || !v.content.trim()) return [];
    const sources = Array.isArray(v.sources)
      ? v.sources.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    if (!sources.length) return [];
    if (available && !sources.every((id: string) => available.has(id))) return [];
    const dueAt = resolveDue(v.dueAt, v.due, now, timeZone);
    if (dueAt === undefined) return [];
    return [
      {
        content: v.content.slice(0, 300),
        dueAt,
        dueText: typeof v.dueText === 'string' ? v.dueText.slice(0, 60) : '',
        sources: sources.slice(0, 10),
        ...(v.recurring === 'yearly' ? { recurring: 'yearly' as const } : {}),
      },
    ];
  });
}
/** Resolve a loop's due time: numeric timestamps win; "明天 08:00", "MM-DD HH:mm",
 *  "HH:mm" or ISO strings are interpreted in the configured local timezone.
 *  Any resolved time outside [now − 1d, now + 5y] is rejected: schema-valid
 *  timestamps like year-1970 or year-9999 pass JSON checks but are semantic
 *  garbage the model invented. */
export function resolveDue(
  dueAt: unknown,
  due: unknown,
  now: number,
  timeZone: string,
): number | undefined {
  const sane = (t: number) => t > now - 86400000 && t < now + 5 * 365 * 86400000;
  if (typeof dueAt === 'number' && Number.isFinite(dueAt) && dueAt > 0) {
    return sane(dueAt) ? dueAt : undefined;
  }
  if (typeof due !== 'string' || !due.trim()) return undefined;
  const text = due.trim().replace(/[：]/g, ':');
  const iso = Date.parse(text);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(text)) return sane(iso) ? iso : undefined;
  // "明天 08:00" / "后天 14:30" / bare "08:00" — optional day word plus
  // local wall time; a bare time that already passed rolls to tomorrow.
  const dayWords: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
  const dayMatch = /^(今天|明天|后天|大后天)?\s*(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (dayMatch) {
    const named = !!dayMatch[1];
    const offset = dayMatch[1] ? dayWords[dayMatch[1]!]! : 0;
    const hour = Number(dayMatch[2]),
      minute = Number(dayMatch[3] ?? 0);
    if (hour > 23 || minute > 59) return undefined;
    const sameDay = localWallTime(now, offset, hour, minute, timeZone);
    if (named || sameDay > now) return sameDay;
    return localWallTime(now, offset + 1, hour, minute, timeZone);
  }
  // "09-20 10:00" this year, roll to next year when already past.
  const md = /^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2})(?::(\d{2}))?)?$/.exec(text);
  if (md) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(now))
      .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    const year = Number(parts.year);
    const hour = Number(md[3] ?? 9),
      minute = Number(md[4] ?? 0);
    if (hour > 23 || minute > 59) return undefined;
    const thisYear = localWallTimeFromYMD(year, Number(md[1]), Number(md[2]), hour, minute, timeZone);
    // A date already behind us is the next occurrence, not an expired plan.
    if (!Number.isNaN(thisYear) && thisYear > now) return thisYear;
    const nextYear = localWallTimeFromYMD(
      year + 1,
      Number(md[1]),
      Number(md[2]),
      hour,
      minute,
      timeZone,
    );
    return Number.isNaN(nextYear) ? undefined : nextYear;
  }
  return undefined;
}
/** Milliseconds for a local wall-clock time N days from `now` in `timeZone`. */
function localWallTime(now: number, dayOffset: number, hour: number, minute: number, timeZone: string): number {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now + dayOffset * 86400000));
  const [y, m, d] = date.split('-').map(Number);
  return localWallTimeFromYMD(y!, m!, d!, hour, minute, timeZone);
}
function localWallTimeFromYMD(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const utc = Date.parse(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
  );
  if (Number.isNaN(utc)) return NaN;
  // The zone offset at that wall time (two probes cover DST boundaries):
  // local = UTC + offset, so the epoch is utc - offset.
  let result = utc;
  for (let i = 0; i < 2; i++) {
    const name = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(result))
      .find((p) => p.type === 'timeZoneName')!
      .value;
    const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    const sign = match?.[1] === '-' ? -1 : 1;
    const hh = Number(match?.[2] ?? 0),
      mm = Number(match?.[3] ?? 0);
    result = utc - sign * (hh * 3600000 + mm * 60000);
  }
  return result;
}
/** Model self-assessed mood pulse, clamped; undefined when absent or invalid. */
export function parseMoodPulse(value: unknown): { valence: number; energy: number; reason?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const valence = typeof v.valence === 'number' && Number.isFinite(v.valence) ? Math.max(-1, Math.min(1, v.valence)) : 0;
  const energy = typeof v.energy === 'number' && Number.isFinite(v.energy) ? Math.max(-1, Math.min(1, v.energy)) : 0;
  if (!valence && !energy) return undefined;
  return {
    valence,
    energy,
    ...(typeof v.reason === 'string' && v.reason.trim() ? { reason: v.reason.slice(0, 60) } : {}),
  };
}
export function parseReply(
  text: string,
  stickers: Sticker[],
  allowSkip = false,
  timeZone = 'Asia/Shanghai',
): ParsedReply {
  let raw: any;
  try {
    raw = parseJson(text);
  } catch {
    if (!/[{}]|```|"messages"/.test(text) && text.trim()) {
      const blob = text.trim().slice(0, 6000);
      const annotated = stripSourceAnnotations(blob);
      const { parts: stickerParts, text: stickerText } = annotated.parts.length
        ? { parts: annotated.parts, text: '' }
        : extractInlineStickers(blob, stickers);
      const { parts: splitParts, text: rest } = stripSourceAnnotations(stickerText);
      const all = [...stickerParts, ...splitParts, ...(rest ? [{ type: 'text' as const, text: rest.slice(0, 6000) }] : [])];
      return {
        parts: all.length ? all : [{ type: 'text' as const, text: blob }],
        memories: [],
        descriptions: [],
        openLoops: [],
        resolveLoops: [],
        askedLoops: [],
      };
    }
    throw new Error('回复格式无效');
  }
  if (!Array.isArray(raw.messages)) throw new Error('回复缺少 messages 数组');
  const parts = normalizeTextParts(raw.messages, stickers);
  if (!parts.length && !(allowSkip && raw.messages.length === 0))
    throw new Error('回复没有有效内容');
  const descriptions = Array.isArray(raw.imageDescriptions)
    ? raw.imageDescriptions
        .filter((d: any) => typeof d?.messageId === 'string' && typeof d?.description === 'string')
        .slice(0, MAX_IMAGE_DESCRIPTIONS)
        .map((d: any) => ({ messageId: d.messageId, description: d.description.slice(0, 800) }))
    : [];
  const resolveLoops = Array.isArray(raw.resolveLoops)
    ? raw.resolveLoops
        .filter((s: unknown): s is string => typeof s === 'string')
        .slice(0, OPEN_LOOP_PROMPT_MAX)
    : [];
  const askedLoops = Array.isArray(raw.askedLoops)
    ? raw.askedLoops
        .filter((s: unknown): s is string => typeof s === 'string')
        .slice(0, OPEN_LOOP_PROMPT_MAX)
    : [];
  const moodPulse = parseMoodPulse(raw.moodPulse);
  return {
    parts,
    memories: parseMemories(raw.memoryUpdates),
    descriptions,
    openLoops: parseOpenLoops(raw.openLoops, undefined, Date.now(), timeZone),
    resolveLoops,
    askedLoops,
    ...(moodPulse ? { moodPulse } : {}),
  };
}
