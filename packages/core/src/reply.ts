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
function normalizeTextParts(
  raw: unknown[],
  stickers: Sticker[],
): ReplyPart[] {
  return raw.slice(0, MAX_REPLY_PARTS).flatMap((m: unknown) => {
    if (typeof m === 'string' && m.trim()) {
      const { parts, text } = extractInlineStickers(m, stickers);
      if (parts.length) return [...parts, ...(text ? [{ type: 'text' as const, text }] : [])];
      return [{ type: 'text', text: text.slice(0, 6000) }];
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
 *  parsing inside the tool loop) only the shape is validated. */
export function parseOpenLoops(
  value: unknown,
  available?: Set<string>,
): OpenLoopInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, OPEN_LOOP_PROMPT_MAX).flatMap((v) => {
    if (!v || typeof v.content !== 'string' || !v.content.trim()) return [];
    const due = typeof v.dueAt === 'number' && Number.isFinite(v.dueAt) ? v.dueAt : undefined;
    const sources = Array.isArray(v.sources)
      ? v.sources.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    if (!due || !sources.length) return [];
    if (available && !sources.every((id: string) => available.has(id))) return [];
    return [
      {
        content: v.content.slice(0, 300),
        dueAt: due,
        dueText: typeof v.dueText === 'string' ? v.dueText.slice(0, 60) : '',
        sources: sources.slice(0, 10),
      },
    ];
  });
}
export function parseReply(
  text: string,
  stickers: Sticker[],
  allowSkip = false,
): ParsedReply {
  let raw: any;
  try {
    raw = parseJson(text);
  } catch {
    if (!/[{}]|```|"messages"/.test(text) && text.trim()) {
      const { parts, text: cleaned } = extractInlineStickers(text.trim().slice(0, 6000), stickers);
      if (parts.length)
        return {
          parts: [...parts, ...(cleaned ? [{ type: 'text' as const, text: cleaned }] : [])],
          memories: [],
          descriptions: [],
          openLoops: [],
          resolveLoops: [],
        };
      return {
        parts: [{ type: 'text', text: cleaned }],
        memories: [],
        descriptions: [],
        openLoops: [],
        resolveLoops: [],
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
  return {
    parts,
    memories: parseMemories(raw.memoryUpdates),
    descriptions,
    openLoops: parseOpenLoops(raw.openLoops),
    resolveLoops,
  };
}
