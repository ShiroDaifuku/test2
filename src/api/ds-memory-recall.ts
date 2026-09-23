/**
 * DS娘 v0.4 · 检索式记忆注入（P2）
 *
 * 问题：v0.4 现状是**每轮把整个记忆库三段（user_info/promises/long_term，上限 800/800/2000 字）
 * 全量注入**，既贵（固定 ~3k tokens）又会稀释注意力（任务书 §4/§5/§17）。
 *
 * 做法（不引入 embedding，iOS 侧没有 ONNX 运行时）：
 *   score = 关键词相关度 × α + 新近度 × β + 条目重要度 × γ
 *   取 Top-K（默认 5）渲染成【相关记忆】交给 Rust 注入；命中不足时退回"这次没检索到"。
 * 关键词相关度用「ASCII 词 + 中文 2-gram」做集合重合，避免引入分词依赖。
 *
 * 数据来源（都在前端可取）：
 *   - 手动笔记      `ds_get_notes`（Rust）
 *   - 记忆库四段    `ds_get_memory_bank`（Rust，本模块新增命令）
 *   - 待办/日程     `get_schedules`（Rust）
 *   - 聊天日志      localStorage（`exportChatLog`）
 * 云端的 facts/people 已在记忆库导入时并入 long_term，无需单独取。
 */
import { invoke } from "@tauri-apps/api/core";
import { getSchedules } from "@/api/services/schedule";
import { exportChatLog, type ChatLogEntry } from "@/api/ds-silent-log";
import { personaFlag } from "@/api/ds-persona-flags";

export type RecallSource = "笔记" | "约定" | "用户信息" | "长期经历" | "待办" | "聊天记录";

export interface RecallCandidate {
  text: string;
  source: RecallSource;
  /** 条目重要度 0..1（先验权重：约定 > 用户信息 > 笔记 > 长期经历 > 待办 > 聊天记录） */
  importance: number;
  /** 时间戳（毫秒），用于新近度；未知则 undefined */
  at?: number;
  /** at 的语义：事件/截止时间可判定过去未来；记录时间只能作为相对词锚点。 */
  temporalKind?: "event" | "due" | "recorded";
}

export interface RecallItem extends RecallCandidate {
  relevance: number;
  recency: number;
  score: number;
}

export const SOURCE_IMPORTANCE: Record<RecallSource, number> = {
  约定: 1,
  用户信息: 0.8,
  笔记: 0.7,
  长期经历: 0.5,
  待办: 0.45,
  聊天记录: 0.35,
};

export const ALPHA = 1.0; // 相关度
export const BETA = 0.25; // 新近度
export const GAMMA = 0.35; // 重要度
export const RECENCY_HALF_LIFE_DAYS = 14;

/** 中文停用字（单字层面），避免 2-gram 里全是"的了是" */
const STOP_CHARS = new Set(
  "的了是我你他她它在有和与就不都很也还没这那什么怎么因为所以但是一下子们吗呢吧啊哦嗯".split("")
);

/** 极简分词：ASCII 词（≥2 字符）+ 中文 2-gram（跳过停用字） */
export function tokenize(text: string): Set<string> {
  const t = String(text || "");
  const out = new Set<string>();
  for (const m of t.matchAll(/[A-Za-z0-9]{2,}/g)) out.add(m[0].toLowerCase());
  const han = [...t].filter((c) => /[\u4e00-\u9fff]/.test(c));
  for (let i = 0; i + 1 < han.length; i++) {
    const g = han[i] + han[i + 1];
    if (!STOP_CHARS.has(han[i]) && !STOP_CHARS.has(han[i + 1])) out.add(g);
  }
  return out;
}

/** 余弦式重合（用 sqrt(|A||B|) 归一，避免长条目凭长度取胜） */
export function relevance(query: Set<string>, item: Set<string>): number {
  if (!query.size || !item.size) return 0;
  let hit = 0;
  for (const token of query) if (item.has(token)) hit++;
  return hit / Math.sqrt(query.size * item.size);
}

export function recencyOf(at: number | undefined, now: number): number {
  if (!at || !Number.isFinite(at)) return 0.3;
  const days = Math.max(0, (now - at) / 86400000);
  return Math.exp(-days / RECENCY_HALF_LIFE_DAYS);
}

export function scoreCandidate(
  candidate: RecallCandidate,
  query: Set<string>,
  now: number
): RecallItem {
  const rel = relevance(query, tokenize(candidate.text));
  const rec = recencyOf(candidate.at, now);
  return {
    ...candidate,
    relevance: rel,
    recency: rec,
    score: rel * ALPHA + rec * BETA + candidate.importance * GAMMA,
  };
}

/**
 * 从一段文本里切出条目（按行/句号/分号），跳过过短与纯占位。
 * 只剥掉项目符号与"1. "这类序号，**不能**把行首日期（9/11、2026-09-11）吃掉。
 */
export function splitEntries(text: string, minLen = 6): string[] {
  return String(text || "")
    .split(/[\n。；;]/)
    .map((s) =>
      s
        .trim()
        .replace(/^[-·•]\s*/, "")
        .replace(/^\d+[.、)]\s+/, "")
    )
    .filter((s) => s.length >= minLen && !/^暂无/.test(s));
}

/** 解析 "9/11"、"2026-09-11"、"09-11 20:00" 之类的行首日期 → 时间戳 */
export function parseLeadingDate(text: string, now: number): number | undefined {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();
  const md = /^(\d{1,2})\/(\d{1,2})/.exec(text);
  if (md) {
    const year = new Date(now).getFullYear();
    const t = new Date(year, Number(md[1]) - 1, Number(md[2])).getTime();
    // 未来的月份（跨年）按去年算
    return t > now + 86400000 ? new Date(year - 1, Number(md[1]) - 1, Number(md[2])).getTime() : t;
  }
  return undefined;
}

/** 解析本地绝对日期，避免 YYYY-MM-DD 被 JS 当 UTC 后在东八区显示成 08:00。 */
export function parseAbsoluteDate(text: string | undefined): number | undefined {
  const raw = String(text || "").trim();
  if (!raw) return undefined;
  const local = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(raw);
  if (local) {
    return new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4] || 0),
      Number(local[5] || 0)
    ).getTime();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface RecallInput {
  query: string;
  notes?: { content?: string; created_at?: string; event_at?: string; time_uncertain?: boolean }[];
  /** 记忆库四段。兼容蛇形（Rust `GameMemoryBank` 序列化）与驼峰两种拼写 */
  bank?: {
    user_info?: string;
    long_term?: string;
    promises?: string;
    short_term?: string;
    userInfo?: string;
    longTerm?: string;
    shortTerm?: string;
  };
  todos?: {
    text?: string;
    completed?: boolean;
    deadline?: string;
    remindAt?: string;
    createdAt?: string;
  }[];
  logs?: ChatLogEntry[];
  now?: number;
  k?: number;
}

/** 取四段正文，容忍 snake_case / camelCase 两种写法（Rust 侧是蛇形，前端偶尔用驼峰） */
function bankSections(bank: RecallInput["bank"]) {
  const b = bank || {};
  return {
    userInfo: String(b.user_info ?? b.userInfo ?? ""),
    longTerm: String(b.long_term ?? b.longTerm ?? ""),
    promises: String(b.promises ?? ""),
    shortTerm: String(b.short_term ?? b.shortTerm ?? ""),
  };
}

/** 组装候选池：四段记忆库 + 笔记 + 待办 + 最近聊天记录 */
export function buildCandidates(input: RecallInput, now: number): RecallCandidate[] {
  const out: RecallCandidate[] = [];
  const bank = bankSections(input.bank);
  for (const line of splitEntries(bank.promises)) {
    out.push({
      text: line,
      source: "约定",
      importance: SOURCE_IMPORTANCE.约定,
      at: parseLeadingDate(line, now),
    });
  }
  for (const line of splitEntries(bank.userInfo)) {
    out.push({
      text: line,
      source: "用户信息",
      importance: SOURCE_IMPORTANCE.用户信息,
      at: parseLeadingDate(line, now),
    });
  }
  for (const line of splitEntries(bank.longTerm)) {
    out.push({
      text: line,
      source: "长期经历",
      importance: SOURCE_IMPORTANCE.长期经历,
      at: parseLeadingDate(line, now),
    });
  }
  for (const note of input.notes || []) {
    const text = String(note?.content || "").trim();
    if (text.length < 6) continue;
    const eventAt = parseAbsoluteDate(note?.event_at);
    const recordedAt = parseAbsoluteDate(note?.created_at);
    const hasEventAt = eventAt !== undefined;
    const at = hasEventAt ? eventAt : recordedAt;
    out.push({
      text,
      source: "笔记",
      importance: SOURCE_IMPORTANCE.笔记,
      at,
      temporalKind: hasEventAt ? "event" : "recorded",
    });
  }
  for (const todo of input.todos || []) {
    const text = String(todo?.text || "").trim();
    if (text.length < 4 || todo?.completed) continue;
    const due = String(todo?.deadline || todo?.remindAt || "").trim();
    const dueAt = parseAbsoluteDate(due);
    const createdAt = parseAbsoluteDate(todo?.createdAt);
    out.push({
      text,
      source: "待办",
      importance: SOURCE_IMPORTANCE.待办,
      at: dueAt ?? createdAt,
      temporalKind: dueAt !== undefined ? "due" : "recorded",
    });
  }
  // 聊天记录：只取用户说过的话作为"回忆素材"，她自己的话不作为记忆条目
  for (const entry of input.logs || []) {
    if (!entry || entry.role !== "user") continue;
    const text = String(entry.text || "").trim();
    if (text.length < 8) continue;
    out.push({
      text,
      source: "聊天记录",
      importance: SOURCE_IMPORTANCE.聊天记录,
      at: Number(entry.t) || undefined,
      temporalKind: "recorded",
    });
  }
  return out;
}

/** 去重（同文本保留分更高的）+ 打分排序 + 取 Top-K */
export function recall(input: RecallInput): {
  items: RecallItem[];
  stats: { pool: number; hit: number };
} {
  const now = input.now ?? Date.now();
  const k = input.k ?? 5;
  const query = tokenize(input.query);
  const seen = new Set<string>();
  const scored: RecallItem[] = [];
  for (const candidate of buildCandidates(input, now)) {
    const key = candidate.text.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push(scoreCandidate(candidate, query, now));
  }
  scored.sort((a, b) => b.score - a.score);
  const hit = scored.filter((s) => s.relevance > 0);
  return { items: hit.slice(0, k), stats: { pool: scored.length, hit: hit.length } };
}

/** 渲染成注入块；没有命中时给一句"别硬提以前的事"，避免模型编记忆 */
function temporalLabel(item: RecallItem, now = Date.now()): string {
  if (!item.at || !Number.isFinite(item.at)) return "时间不确定；不能当作当前或未来安排";
  const at = new Date(item.at);
  const absolute = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (item.temporalKind === "recorded") {
    return `记录于 ${absolute}；原文中的“今天/明天”等只相对该记录时间，不代表现在`;
  }
  if (item.at < now)
    return `${item.temporalKind === "due" ? "截止" : "事件"}时间 ${absolute}，现已过去`;
  return `${item.temporalKind === "due" ? "截止" : "事件"}时间 ${absolute}，尚未到达`;
}

export function renderRecallBlock(items: RecallItem[], now = Date.now()): string {
  if (!items.length)
    return "【相关记忆】这次没有检索到和他当前话题相关的过去记录，不要硬提以前的事，也不要编。";
  const lines = items.map(
    (item) => `· ${item.text}（${item.source}；${temporalLabel(item, now)}）`
  );
  return [
    "【相关记忆】（当前时间由系统另行提供。必须按每条的绝对时间判断过去/未来；过去计划只能当历史，不能说成即将发生。）",
    ...lines,
  ].join("\n");
}

/**
 * 每轮发送前调用：从本地各来源检索 → 推给 Rust，供本轮 system prompt 注入。
 * `replaceBank: true` 表示"本轮不要全量注入记忆库三段，用检索结果代替"。
 * 任何异常都只打日志：检索失败最多是记忆差一点，不该影响聊天。
 */
export async function prepareRecall(
  query: string,
  opts: { k?: number; replaceBank?: boolean } = {}
): Promise<{ items: number; pool: number } | null> {
  try {
    const [notes, bank, schedules] = await Promise.all([
      invoke<
        { content?: string; created_at?: string; event_at?: string; time_uncertain?: boolean }[]
      >("ds_get_notes").catch(() => []),
      invoke<RecallInput["bank"]>("ds_get_memory_bank").catch(() => undefined),
      getSchedules().catch(() => undefined),
    ]);
    const todos = Object.values(
      (schedules?.todoGroups || {}) as Record<
        string,
        {
          todos?: {
            text?: string;
            completed?: boolean;
            deadline?: string;
            remindAt?: string;
            createdAt?: string;
          }[];
        }
      >
    ).flatMap((group) => group?.todos || []);
    const logs = exportChatLog().slice(-200);
    const { items, stats } = recall({ query, notes, bank, todos, logs, k: opts.k ?? 5 });
    await invoke("ds_set_memory_recall", {
      text: renderRecallBlock(items),
      replaceBank: opts.replaceBank !== false,
      stats: { ...stats, picked: items.length },
    });
    return { items: items.length, pool: stats.pool };
  } catch (e) {
    console.warn("[记忆检索] 本轮检索失败（退回全量注入）:", e);
    return null;
  }
}

/**
 * 发送一条用户消息前的统一准备工作（三个发送入口都调它）。
 * 目前只做记忆检索；将来若要加"按时间段的语气调整"之类，也挂在这里。
 * 受 `memoryRetrieval` 开关控制（默认关，见 ds-persona-flags.ts）。
 */
export async function prepareTurnRecall(text: string): Promise<void> {
  if (!personaFlag("memoryRetrieval")) return;
  const query = String(text || "").trim();
  if (!query) return;
  await prepareRecall(query, { k: 5, replaceBank: true });
}
