/**
 * DS娘 v0.4 · Persona 状态层（P2：关系/情感状态数值化）
 *
 * 设计要点（对齐任务书 §12/§13/§18）：
 *  1. 状态**存在程序里**，不是每轮让 LLM 重新猜；LLM 只负责把状态表达成语言。
 *  2. 不同变量有不同的时间尺度与单轮上限（`max_delta`），避免"一句话让人格突变"：
 *       affect（短期情绪）   半衰期 6h，单轮最多 ±0.12
 *       relation（关系）     向基线回归，半衰期 72h，单轮最多 ±0.02
 *  3. 状态由**情绪标签**（模型自己给的那 20 个词）+ 用户消息情感 驱动，
 *     **不额外调用任何 API**（零延迟、零成本）。
 *  4. 只做数值与文本渲染，不碰 UI/Tauri 之外的副作用；便于本地单测。
 *
 * 注入方式：渲染成一小段【当前状态】文本，由 Rust 在每轮拼进 system prompt
 * （见 `ds-persona-state.ts::pushStateToApp` → Rust `ds_set_persona_state`）。
 */
import { invoke } from "@tauri-apps/api/core";
import { personaFlag } from "@/api/ds-persona-flags";

export interface AffectState {
  /** 愉悦度 −1..1 */
  valence: number;
  /** 唤醒度 0..1 */
  arousal: number;
  /** 精力 0..1 */
  energy: number;
  /** 烦躁 0..1 */
  irritation: number;
  /** 脆弱/易受伤 0..1 */
  vulnerability: number;
  /** 社交意愿 0..1 */
  socialEnergy: number;
}

export interface RelationState {
  /** 信任 0..1 */
  trust: number;
  /** 亲近 0..1 */
  intimacy: number;
  /** 熟悉 0..1 */
  familiarity: number;
  /** 当前紧张感 0..1 */
  tension: number;
  /** 温度/亲热 0..1 */
  warmth: number;
}

export interface PersonaState {
  affect: AffectState;
  relation: RelationState;
  meta: {
    /** 上次更新（毫秒） */
    updatedAt: number;
    /** 上次对话（毫秒） */
    lastChatAt: number;
    /** 累计轮数 */
    turns: number;
    /** 由 affect 派生的情绪名（给 prompt 用的中文标签） */
    moodLabel: string;
  };
}

// ─── 常量（时间尺度与上限）──────────────────────────────
/** 短期情绪半衰期（小时）：情绪会自己淡下去 */
export const AFFECT_HALF_LIFE_H = 6;
/** 关系回归基线的半衰期（小时）：关系变化慢，也会慢慢回落 */
export const RELATION_HALF_LIFE_H = 72;
/** 单轮情绪最大变化量（防止一句话让情绪崩掉/飙升） */
export const MAX_DELTA_AFFECT = 0.12;
/** 单轮关系最大变化量 */
export const MAX_DELTA_RELATION = 0.02;
/** 每轮自然增长的熟悉度 */
export const FAMILIARITY_PER_TURN = 0.004;

/** 关系的"基线"：长期不说话会回落到这里 */
export const RELATION_BASELINE: RelationState = {
  trust: 0.55,
  intimacy: 0.45,
  familiarity: 0.7,
  tension: 0.05,
  warmth: 0.55,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const clampSigned = (v: number) => clamp(v, -1, 1);

export function defaultState(now = Date.now()): PersonaState {
  return {
    affect: { valence: 0.1, arousal: 0.35, energy: 0.55, irritation: 0.05, vulnerability: 0.25, socialEnergy: 0.5 },
    relation: { ...RELATION_BASELINE },
    meta: { updatedAt: now, lastChatAt: 0, turns: 0, moodLabel: "平静" },
  };
}

// ─── 衰减 ───────────────────────────────────────────────
/** 指数衰减：affect 向 0 回落，relation 向基线回落 */
export function decay(state: PersonaState, now = Date.now()): PersonaState {
  const hours = Math.max(0, (now - state.meta.updatedAt) / 3600000);
  if (hours <= 0) return state;
  const kAffect = Math.pow(0.5, hours / AFFECT_HALF_LIFE_H);
  const kRelation = Math.pow(0.5, hours / RELATION_HALF_LIFE_H);
  const a = state.affect;
  const r = state.relation;
  return {
    affect: {
      valence: clampSigned(a.valence * kAffect),
      arousal: clamp01(0.35 + (a.arousal - 0.35) * kAffect),
      energy: clamp01(0.55 + (a.energy - 0.55) * kAffect),
      irritation: clamp01(a.irritation * kAffect),
      vulnerability: clamp01(0.25 + (a.vulnerability - 0.25) * kAffect),
      socialEnergy: clamp01(0.5 + (a.socialEnergy - 0.5) * kAffect),
    },
    relation: {
      trust: clamp01(RELATION_BASELINE.trust + (r.trust - RELATION_BASELINE.trust) * kRelation),
      intimacy: clamp01(RELATION_BASELINE.intimacy + (r.intimacy - RELATION_BASELINE.intimacy) * kRelation),
      familiarity: clamp01(RELATION_BASELINE.familiarity + (r.familiarity - RELATION_BASELINE.familiarity) * kRelation),
      tension: clamp01(RELATION_BASELINE.tension + (r.tension - RELATION_BASELINE.tension) * kRelation),
      warmth: clamp01(RELATION_BASELINE.warmth + (r.warmth - RELATION_BASELINE.warmth) * kRelation),
    },
    meta: { ...state.meta, updatedAt: now },
  };
}

// ─── 驱动信号 ───────────────────────────────────────────
type AffectDelta = Partial<AffectState>;

/** 20 个情绪标签 → 情绪增量表（幅度都很小，靠累积与衰减形成"心情") */
export const EMOTION_AFFECT: Record<string, AffectDelta> = {
  高兴: { valence: 0.1, arousal: 0.05 },
  兴奋: { valence: 0.11, arousal: 0.14, socialEnergy: 0.08 },
  平静: { valence: 0.02, arousal: -0.05, irritation: -0.04 },
  正常: {},
  认真: { arousal: 0.03, energy: -0.02 },
  自信: { valence: 0.05, arousal: 0.04 },
  调皮: { valence: 0.07, arousal: 0.08, socialEnergy: 0.05 },
  心动: { valence: 0.09, arousal: 0.1, vulnerability: 0.08 },
  害羞: { arousal: 0.08, vulnerability: 0.1, socialEnergy: -0.04 },
  难为情: { arousal: 0.07, vulnerability: 0.1, socialEnergy: -0.03 },
  慌张: { arousal: 0.13, vulnerability: 0.06 },
  紧张: { arousal: 0.1, vulnerability: 0.04 },
  害怕: { arousal: 0.12, valence: -0.08, vulnerability: 0.1 },
  担心: { arousal: 0.05, valence: -0.03 },
  惊讶: { arousal: 0.12 },
  疑惑: { arousal: 0.04 },
  无奈: { valence: -0.05, arousal: -0.03 },
  生气: { arousal: 0.12, valence: -0.1, irritation: 0.15 },
  厌恶: { valence: -0.12, irritation: 0.12 },
  伤心: { valence: -0.14, arousal: -0.06, vulnerability: 0.08 },
};

/** 用户消息里的正/负向词（沿用老版鲸鱼娘的词表，纯本地正则，无 API） */
const USER_POS = /(开心|高兴|太好了|太棒|很棒|好棒|真棒|厉害|牛|谢谢|感谢|喜欢|爱你|爱了|赞|优秀|完美|超赞|棒呆|芜湖|起飞|哈哈|嘻嘻|嘿嘿|nice|好耶)/;
const USER_NEG = /(难过|伤心|想哭|哭了|崩溃|沮丧|失落|烦躁|生气|气死|讨厌|烦死|好累|好困|疲惫|焦虑|害怕|担心|委屈|难受|emo|唉|呜呜|抑郁|痛苦|没意思|无聊|累了)/;
/** 推开她的信号（关系里会积累紧张感） */
const USER_REBUFF = /(算了|别管我|跟你说也没用|不用你管|烦不烦|少管|闭嘴|滚|别烦我)/;
/** 自我暴露/示弱（会加深亲近） */
const USER_DISCLOSE = /(其实我|我一直|我从来没|我小时候|我跟你说|没人知道|只有你|我不太会|我害怕|我讨厌自己)/;

export interface TurnSignals {
  userText: string;
  /** 这一轮她说话用到的情绪标签 */
  emotionTags: string[];
  now?: number;
}

export function userSentiment(userText: string): { positive: boolean; negative: boolean; rebuff: boolean; disclose: boolean } {
  const t = String(userText || "");
  const positive = USER_POS.test(t);
  const negative = USER_NEG.test(t);
  return { positive: positive && !negative, negative: negative && !positive, rebuff: USER_REBUFF.test(t), disclose: USER_DISCLOSE.test(t) };
}

/** 把增量收敛到单轮上限内（按最大分量等比缩放） */
function limitDelta<T extends Record<string, number | undefined>>(delta: T, maxAbs: number): T {
  const values = Object.values(delta).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const peak = values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak <= maxAbs || peak === 0) return delta;
  const k = maxAbs / peak;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(delta)) if (typeof value === "number") out[key] = value * k;
  return out as T;
}

/**
 * 一轮对话结束后更新状态：先衰减、再叠加本轮信号、再限幅、再钳位。
 * `turns` 每轮 +1，`familiarity` 也随之缓慢上升（上限 0.98）。
 */
export function applyTurn(state: PersonaState, signals: TurnSignals): PersonaState {
  const now = signals.now ?? Date.now();
  const base = decay(state, now);
  const tags = Array.isArray(signals.emotionTags) ? signals.emotionTags : [];

  // 1) 她的情绪标签 → affect 增量（多个标签取平均，避免多句刷满）
  const affectDelta: AffectDelta = {};
  let counted = 0;
  for (const tag of tags) {
    const table = EMOTION_AFFECT[tag];
    if (!table) continue;
    counted++;
    for (const [key, value] of Object.entries(table)) {
      affectDelta[key as keyof AffectState] = (affectDelta[key as keyof AffectState] ?? 0) + (value as number);
    }
  }
  if (counted > 0) {
    for (const key of Object.keys(affectDelta) as (keyof AffectState)[]) {
      affectDelta[key] = (affectDelta[key] as number) / counted;
    }
  }
  // 2) 用户消息情感 → affect
  const s = userSentiment(signals.userText);
  if (s.positive) {
    affectDelta.valence = (affectDelta.valence ?? 0) + 0.05;
    affectDelta.socialEnergy = (affectDelta.socialEnergy ?? 0) + 0.04;
  }
  if (s.negative) {
    affectDelta.valence = (affectDelta.valence ?? 0) - 0.04;
    affectDelta.energy = (affectDelta.energy ?? 0) - 0.03;
  }
  if (s.rebuff) {
    affectDelta.valence = (affectDelta.valence ?? 0) - 0.06;
    affectDelta.irritation = (affectDelta.irritation ?? 0) + 0.08;
  }
  if (s.disclose) {
    affectDelta.vulnerability = (affectDelta.vulnerability ?? 0) + 0.04;
  }

  const limitedAffect = limitDelta(affectDelta, MAX_DELTA_AFFECT);
  const affect: AffectState = {
    valence: clampSigned(base.affect.valence + (limitedAffect.valence ?? 0)),
    arousal: clamp01(base.affect.arousal + (limitedAffect.arousal ?? 0)),
    energy: clamp01(base.affect.energy + (limitedAffect.energy ?? 0)),
    irritation: clamp01(base.affect.irritation + (limitedAffect.irritation ?? 0)),
    vulnerability: clamp01(base.affect.vulnerability + (limitedAffect.vulnerability ?? 0)),
    socialEnergy: clamp01(base.affect.socialEnergy + (limitedAffect.socialEnergy ?? 0)),
  };

  // 3) 关系增量（慢、且很小）
  const relationDelta: Partial<RelationState> = {};
  if (s.positive) {
    relationDelta.warmth = (relationDelta.warmth ?? 0) + 0.008;
    relationDelta.trust = (relationDelta.trust ?? 0) + 0.004;
  }
  if (s.negative || s.disclose) {
    // 他愿意说难受的事 = 亲近；但持续冲突会积累紧张
    relationDelta.intimacy = (relationDelta.intimacy ?? 0) + 0.006;
    relationDelta.warmth = (relationDelta.warmth ?? 0) + 0.004;
  }
  if (s.rebuff) {
    relationDelta.tension = (relationDelta.tension ?? 0) + 0.02;
    relationDelta.warmth = (relationDelta.warmth ?? 0) - 0.008;
  }
  if (tags.some((t) => t === "心动" || t === "害羞" || t === "难为情")) {
    relationDelta.intimacy = (relationDelta.intimacy ?? 0) + 0.006;
    relationDelta.tension = (relationDelta.tension ?? 0) - 0.004;
  }
  if (tags.some((t) => t === "生气" || t === "厌恶")) {
    relationDelta.tension = (relationDelta.tension ?? 0) + 0.01;
  }
  relationDelta.familiarity = (relationDelta.familiarity ?? 0) + FAMILIARITY_PER_TURN;

  const limitedRelation = limitDelta(relationDelta, MAX_DELTA_RELATION);
  const relation: RelationState = {
    trust: clamp01(base.relation.trust + (limitedRelation.trust ?? 0)),
    intimacy: clamp01(base.relation.intimacy + (limitedRelation.intimacy ?? 0)),
    familiarity: clamp(Math.min(base.relation.familiarity + (limitedRelation.familiarity ?? 0), 0.98), 0, 0.98),
    tension: clamp01(base.relation.tension + (limitedRelation.tension ?? 0)),
    warmth: clamp01(base.relation.warmth + (limitedRelation.warmth ?? 0)),
  };

  const turns = base.meta.turns + 1;
  const moodLabel = moodOf(affect);
  return { affect, relation, meta: { updatedAt: now, lastChatAt: now, turns, moodLabel } };
}

/** 由 affect 推出一个中文情绪名（给 prompt 用；纯查表，稳定可测） */
export function moodOf(affect: AffectState): string {
  const { valence, arousal, irritation, vulnerability } = affect;
  if (irritation >= 0.45) return "有点烦躁";
  if (valence <= -0.35) return vulnerability >= 0.5 ? "难过又脆弱" : "低落";
  if (valence >= 0.45 && arousal >= 0.55) return "兴奋";
  if (valence >= 0.35) return "心情不错";
  if (arousal >= 0.6) return "有点紧张";
  if (arousal <= 0.2 && valence <= 0.1) return "懒懒的";
  return "平静";
}

/** 距离上次对话多久（人类可读，给 prompt 用）。不到 1 小时不提，避免"约 1 小时"这种噪声。 */
export function gapText(state: PersonaState, now = Date.now()): string {
  const last = state.meta.lastChatAt;
  if (!last) return "";
  const hours = (now - last) / 3600000;
  if (hours < 1) return "";
  if (hours < 24) return `距离上次说话约 ${Math.round(hours)} 小时。`;
  const days = Math.round(hours / 24);
  return `距离上次说话约 ${days} 天。`;
}

const pct = (v: number) => v.toFixed(2);

/**
 * 渲染成注入 prompt 的状态文本（简短，约 120-180 字）。
 * 刻意只给"气氛"和少数关键数值，避免模型把数字念出来。
 */
export function renderStateText(state: PersonaState, now = Date.now()): string {
  const a = state.affect;
  const r = state.relation;
  const closeness = r.intimacy >= 0.7 ? "很亲近" : r.intimacy >= 0.55 ? "比一般朋友近" : "熟但还没到随便撒娇";
  const tension = r.tension >= 0.3 ? "最近有点别扭" : r.tension >= 0.12 ? "气氛里有一点没散开的小别扭" : "没有未解决的别扭";
  return [
    "【当前状态】（这是你此刻真实的心理与关系状态，请自然地体现在语气里，不要把数字念出来）",
    `心情：${state.meta.moodLabel}（愉悦 ${pct(a.valence)}，唤醒 ${pct(a.arousal)}，精力 ${pct(a.energy)}，烦躁 ${pct(a.irritation)}，脆弱 ${pct(a.vulnerability)}）`,
    `关系：信任 ${pct(r.trust)}，亲近 ${pct(r.intimacy)}（${closeness}），熟悉 ${pct(r.familiarity)}，${tension}`,
    gapText(state, now),
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── 持久化与同步 ───────────────────────────────────────
const STORAGE_KEY = "ds_persona_state_v1";

export function loadState(now = Date.now()): PersonaState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState(now);
    const parsed = JSON.parse(raw) as PersonaState;
    if (!parsed?.affect || !parsed?.relation || !parsed?.meta) return defaultState(now);
    return decay(parsed, now);
  } catch {
    return defaultState(now);
  }
}

export function saveState(state: PersonaState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("[状态层] 保存失败:", e);
  }
}

/**
 * 把状态渲染文本推给 Rust，供下一轮注入 system prompt。
 * 失败只打日志（状态层不该影响聊天主链路）。
 */
export async function pushStateToApp(state: PersonaState, now = Date.now()): Promise<void> {
  try {
    await invoke("ds_set_persona_state", { text: renderStateText(state, now), state });
  } catch (e) {
    console.warn("[状态层] 同步给 App 失败（不影响聊天）:", e);
  }
}

/** 一轮结束后：更新 → 落盘 → 推送。受 `dynamicState` 开关控制（默认关，见 ds-persona-flags.ts） */
export async function updatePersonaStateAfterTurn(signals: TurnSignals): Promise<PersonaState | null> {
  if (!personaFlag("dynamicState")) return null;
  const now = signals.now ?? Date.now();
  const next = applyTurn(loadState(now), signals);
  saveState(next);
  await pushStateToApp(next, now);
  return next;
}

/** 启动时：只做衰减并把结果推给 Rust（保证 prompt 里有一段当前状态）。受 `dynamicState` 开关控制。 */
export async function refreshPersonaStateOnStart(now = Date.now()): Promise<PersonaState | null> {
  if (!personaFlag("dynamicState")) return null;
  const next = decay(loadState(now), now);
  saveState(next);
  await pushStateToApp(next, now);
  return next;
}
