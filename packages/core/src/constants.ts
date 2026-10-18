/** Tuning knobs that were previously scattered as magic numbers. */

/** Recent user messages feeding the auto-recall query. */
export const RECALL_QUERY_MESSAGES = 3;
export const RECALL_QUERY_MAX_CHARS = 1000;
/** Auto-recalled hits and long-term memories placed into the system prompt. */
export const RECALL_HITS = 6;
export const PROMPT_MEMORIES = 10;
/** Per-item truncation for prompt materials. */
export const RECALL_CONTENT_MAX_CHARS = 600;
export const MEMORY_CONTENT_MAX_CHARS = 500;
export const PROMPT_STICKERS = 32;

/** Fraction of the input budget reserved for tools and the latest turns. */
export const TOOL_RESERVE_MAX_TOKENS = 6000;
export const CONTEXT_FLEX_FRACTION = 0.25;
/** Minimum headroom kept when assembling the system prompt. */
export const PROMPT_HEADROOM_TOKENS = 256;
/** Tool-loop limits per reply. */
export const MAX_TOOL_ROUNDS = 2;
export const MAX_TOOL_CALLS = 4;
export const MAX_REPLY_ATTEMPTS = 4;
/** Tool result budget shared across one reply. */
export const TOOL_RESULT_BUDGET_TOKENS = 6000;
/** Cap on assistant bubbles and memory updates per reply. */
export const MAX_REPLY_PARTS = 6;
export const MAX_MEMORY_UPDATES = 6;
export const MAX_IMAGE_DESCRIPTIONS = 4;
export const MAX_IMAGES_PER_TURN = 2;
/** Notes (topic summary) token cap inside prompts. */
export const NOTES_MAX_TOKENS = 1500;
/** Notes trigger: recent window length and its share of the input budget. */
export const NOTES_MIN_MESSAGES = 20;
export const NOTES_WINDOW = 200;
export const NOTES_BUDGET_SHARE = 0.65;
/** Messages kept after the notes cursor (recent turns stay out of notes). */
export const NOTES_TAIL_EXEMPT = 13;

/** Diary batching limits. */
export const DIARY_MAX_CHARS = 22000;
export const DIARY_MAX_SECTIONS = 6;

/** Sticker usage feedback shown to the model. */
export const STICKER_RECENT_SHOWN = 8;

/** Time awareness: silence gaps rendered for the model. */
export const SILENCE_NOTIFY_MINUTES = 30;
export const SILENCE_HOURS_THRESHOLD = 4;

/** Proactive contact jitter: attempts get a random delay inside this window. */
export const PROACTIVE_JITTER_MINUTES = 20;
/** Proactive brake: after this many unanswered pings, pause for days. */
export const PROACTIVE_IGNORE_LIMIT = 2;
export const PROACTIVE_IGNORE_COOLDOWN_DAYS = 3;
/** Open loops: expire silently after this many days past due. */
export const OPEN_LOOP_EXPIRE_DAYS = 7;
export const OPEN_LOOP_PROMPT_MAX = 5;
/** Rhythm hint: minimum hourly messages before a bucket counts as habitual. */
export const RHYTHM_MIN_BUCKET = 3;
/** How many busiest hours to describe when a user has no clear routine. */
export const RHYTHM_PEAK_BUCKETS = 6;
/** Embedding refresh: batch size per backfill pass. */
export const EMBED_BACKFILL_BATCH = 64;
