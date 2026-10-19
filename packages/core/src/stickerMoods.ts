import type { Sticker } from './reply.js';

export interface StickerMood {
  id: string;
  name: string;
}

export interface StickerIntensity {
  /** mood id -> 1..4 (mild to strong) */
  [moodId: string]: number;
}

export interface CatalogSticker extends Sticker {
  intensity?: StickerIntensity;
}

/** Built-in mood presets. Admins can add/remove via settings; these stay as
 *  the fallback so a fresh install has a usable taxonomy. */
export const MOOD_PRESETS: StickerMood[] = [
  { id: 'happy', name: '开心' },
  { id: 'cute', name: '撒娇卖萌' },
  { id: 'aggrieved', name: '委屈' },
  { id: 'sad', name: '伤心' },
  { id: 'miss', name: '想念' },
  { id: 'angry', name: '生气' },
  { id: 'clingy', name: '贴贴亲近' },
  { id: 'encourage', name: '鼓励打气' },
  { id: 'lazy', name: '摆烂躺平' },
  { id: 'surrender', name: '认怂道歉' },
  { id: 'curious', name: '好奇八卦' },
  { id: 'night', name: '熬夜困倦' },
  { id: 'celebrate', name: '庆祝' },
  { id: 'jealous', name: '吃醋' },
];

const mood = (id: string, level: number) => ({ [id]: Math.max(1, Math.min(4, level)) });

/** Keyword-based auto-classification: catalog tags mapped onto mood presets.
 *  Level is a judgement call per sticker — refined by hand in the admin UI. */
export function autoClassify(sticker: { tags: string[] }): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (id: string, level: number) => {
    out[id] = out[id] ? Math.max(out[id], level) : level;
  };
  for (const tag of sticker.tags) {
    if (/^(开心|高兴|甜|热情|温柔|可爱|欣慰)/.test(tag)) add('happy', 2);
    if (/^(笑|点赞|捧场)/.test(tag)) add('happy', 1);
    if (/^(撒娇|爱意|求抱|要哄|粘人)/.test(tag)) add('cute', 3);
    if (/^(委屈|心虚|被抛弃|忍泪)/.test(tag)) add('aggrieved', 2);
    if (/^(难过|眼泪|大哭)/.test(tag)) add('sad', tag === '大哭' ? 4 : 3);
    if (/^(想念|寻找|想你|盯着你|等待)/.test(tag)) add('miss', 2);
    if (/^(生气|憋怒|威胁|凶|不理你|拉黑|绝交|发脾气|催回复|爆发前)/.test(tag))
      add('angry', tag === '憋怒' || tag === '爆发前' ? 2 : 3);
    if (/^(贴贴|拥抱|抱抱|亲亲|亲近|隔屏贴贴)/.test(tag)) add('clingy', 2);
    if (/^(鼓励|加油|支持|承诺|自信|汇报)/.test(tag)) add('encourage', 2);
    if (/^(摆烂|睡觉|躺平|解放|收工)/.test(tag)) add('lazy', 2);
    if (/^(认怂|投降|认错|道歉|求饶|乖)/.test(tag)) add('surrender', 2);
    if (/^(好奇|偷看|嘴馋|讨吃|思考|想办法|烧脑)/.test(tag)) add('curious', 2);
    if (/^(熬夜)/.test(tag)) add('night', 2);
    if (/^(庆祝)/.test(tag)) add('celebrate', 3);
    if (/^(吃醋)/.test(tag)) add('jealous', 3);
  }
  return out;
}

/** Fill in missing intensity data for a catalog entry without overwriting
 *  hand-tuned values from the admin UI. */
export function ensureIntensity(sticker: CatalogSticker): StickerIntensity {
  return { ...autoClassify(sticker), ...(sticker.intensity ?? {}) };
}
