/**
 * DS娘 v0.4 · 静默云同步（Cloudflare Worker「记忆中枢」）
 *
 * 目标：**日志 / 记忆（手动笔记）/ 待办** 三类数据在「每次启动」和「每轮对话完成」时
 * 静默与云端做一次双向合并。默认开启，可在设置里关掉（`ds.cloud_sync`）。
 *
 * 铁律：
 *  1. 绝不抛异常——所有错误只写进 `cloudSyncState()`，调用方（含 main.ts 的定时器）
 *     不会因为同步失败而中断；不弹通知、不新增任何 UI。
 *  2. 绝不阻塞聊天：防抖 3 秒 + 30 秒 fetch 超时，最坏情况也只是后台慢慢失败。
 *  3. 不新增依赖、不改 DB 结构：待办走既有 `getSchedules/saveSchedules`，
 *     笔记走新增的 `ds_get_notes/ds_set_notes`，日志走 `ds-silent-log` 的 localStorage。
 *
 * 协议（既有，不改）：
 *   PUT {url}/api/memory
 *   Header: X-Whale-Token: <token>, Content-Type: application/json
 *   Body:   { "memory": <记忆对象> }
 *   返回:   { ok: true, memory: <权威合并后的记忆对象> }
 */

import { invoke } from "@tauri-apps/api/core";
import { getEnvConfigByKey, saveEnvConfig } from "@/api/services/config";
import { getSchedules, saveSchedules } from "@/api/services/schedule";
import { exportChatLog, replaceChatLog, type ChatLogEntry } from "@/api/ds-silent-log";

// ─── 本地结构类型 ───

/** 本地手动笔记（Rust `memory::Note` 的序列化形状，见 src-tauri/src/ai_service/tools/memory.rs:24-31） */
interface LocalNote {
  id: string;
  content: string;
  tags?: string[];
  created_at?: string;
}

/** 本地待办（TodoPage 的形状：id 为 Date.now() 毫秒数，见 TodoPage.vue:411-417） */
interface LocalTodo {
  [key: string]: unknown;
  id: number;
  text: string;
  priority: number;
  completed: boolean;
  deadline?: string;
  /** 提醒时间（本地 "YYYY-MM-DD HH:MM"），到点发系统通知；随待办一起备份到云端 */
  remindAt?: string;
}

interface LocalTodoGroup {
  [key: string]: unknown;
  title: string;
  description?: string;
  todos: LocalTodo[];
}

// ─── 云端 bank 结构类型（沿用既有协议） ───

interface CloudNote {
  id: string;
  content: string;
  tag?: string;
  time?: string;
  hits?: number;
}

interface CloudSchedule {
  id: string | number;
  content: string;
  status?: string;
  time?: string;
  date?: string;
  importance?: number;
  group?: string;
  doneAt?: string;
  /**
   * 提醒时间（DS娘 v0.4 本地字段）。Worker（`云端记忆中枢/_worker.js`，版本 v0.4-todo-remind）
   * 会原样保存并在合并时保留它；推送时总是带上（空字符串表示清除提醒）。
   */
  remindAt?: string;
}

interface CloudMemory {
  bank?: {
    notes?: CloudNote[];
    profile?: Record<string, unknown>;
    schedule?: CloudSchedule[];
  };
  summary?: string;
  diary?: Record<string, unknown>;
  logs?: Array<Record<string, unknown>>;
  /**
   * 旧版（云端记忆中枢 + 桌宠/记忆桥）遗留字段，见 `DS娘_云端部署包/_worker.js:165`
   * 的 `defaultMemory()`：`{ user, people, state, events, facts, ... }`。
   * 新版 Worker 与两端并行保留（`_worker.js:652-762`：旧字段照旧合并、写入 bank 的
   * 同时不删旧字段），所以我们**读取时只做兼容**，不写回、不改协议。
   */
  user?: Record<string, unknown>;
  people?: Record<string, { relation?: string; info?: string[] }>;
  facts?: Array<{ text?: string; cat?: string } | string>;
}

// ─── 设置读取（带缓存） ───

interface CloudSettings {
  /** 总开关（ds.cloud_sync，默认 true） */
  enabled: boolean;
  /** 记忆中枢地址（ds.cloud_url） */
  url: string;
  /** 配对令牌（ds.cloud_token，空则跳过同步） */
  token: string;
}

/**
 * CI 注入的环境变量（见 .github/workflows/build-ios.yml）。
 * **地址与令牌都不写死在源码里**——本仓库是公开仓库，硬编码会暴露云端端点。
 * 本地未注入时二者都为空字符串，同步会自动跳过（可在设置里手动填）。
 */
const ENV = (import.meta as unknown as { env?: Record<string, string> }).env || {};
/** 记忆中枢地址：构建期由 VITE_WHALE_URL 注入，并在首次同步时写回设置 */
const DEFAULT_URL = String(ENV.VITE_WHALE_URL || "").trim();

let settingsCache: CloudSettings | null = null;

/** 清空设置缓存（设置页保存 ds.cloud_* 后可调用，保证下次同步读到新值）。 */
export function invalidateCloudSettings(): void {
  settingsCache = null;
}

/** 读单个设置项；失败/缺省时回落默认值，**绝不抛**。`getEnvConfigByKey` 失败会 throw，这里吞掉。 */
async function readSetting(key: string, fallback: string): Promise<string> {
  try {
    const item = await getEnvConfigByKey(key);
    const value = (item as { value?: unknown } | null)?.value;
    if (value === undefined || value === null) return fallback;
    return String(value);
  } catch (e) {
    console.warn("[DS娘·云同步] 读取设置失败，按默认处理:", key, e);
    return fallback;
  }
}

/**
 * 读取云同步设置（进程内缓存）。
 * 读失败时返回「关闭」——同步宁可不做，也不能因为设置读不出来而报错。
 */
async function loadCloudSettings(): Promise<CloudSettings> {
  if (settingsCache) return settingsCache;
  const off: CloudSettings = { enabled: false, url: DEFAULT_URL, token: "" };
  try {
    const [rawEnabled, rawUrl, rawToken] = await Promise.all([
      readSetting("ds.cloud_sync", "true"),
      readSetting("ds.cloud_url", DEFAULT_URL),
      readSetting("ds.cloud_token", ""),
    ]);
    let enabled = rawEnabled.trim().toLowerCase() !== "false";
    const url = rawUrl.trim() || DEFAULT_URL;
    let token = rawToken.trim();

    // 地址兜底：设置里没有地址时，用 CI 注入的 VITE_WHALE_URL（构建期环境变量）并写回设置。
    // 这样公开仓库里既没有令牌、也没有云端端点。
    if (!rawUrl.trim() && DEFAULT_URL) {
      try {
        await saveEnvConfig({ "ds.cloud_url": DEFAULT_URL });
        invalidateCloudSettings();
      } catch (e) {
        console.warn("[DS娘·云同步] 回写 VITE_WHALE_URL 到设置失败（本次仍用环境变量同步）:", e);
      }
    }

    // Key 兜底：设置里没有令牌时，用 CI 注入的 VITE_WHALE_TOKEN（构建期环境变量），
    // 并写回设置，保证下次启动/其它窗口一致。写回失败不影响本次同步。
    if (!token) {
      const envToken = String(ENV.VITE_WHALE_TOKEN || "").trim();
      if (envToken) {
        token = envToken;
        try {
          await saveEnvConfig({ "ds.cloud_token": envToken });
          invalidateCloudSettings();
        } catch (e) {
          console.warn("[DS娘·云同步] 回写 VITE_WHALE_TOKEN 到设置失败（本次仍用环境变量同步）:", e);
        }
      }
    }

    if (!token) {
      enabled = false;
      console.warn(
        "[DS娘·云同步] 未配置 ds.cloud_token 且未注入 VITE_WHALE_TOKEN，跳过云同步"
      );
    }
    if (!url) {
      enabled = false;
      console.warn("[DS娘·云同步] 未配置 ds.cloud_url 且未注入 VITE_WHALE_URL，跳过云同步");
    }
    settingsCache = { enabled, url, token };
    return settingsCache;
  } catch (e) {
    console.warn("[DS娘·云同步] 读取云同步设置异常，按关闭处理:", e);
    settingsCache = off;
    return off;
  }
}

// ─── 状态（供自检/设置页只读展示，不弹通知） ───

interface CloudSyncState {
  at: number;
  ok: boolean | null;
  error: string;
  pushed: number;
  pulled: number;
}

const state: CloudSyncState = { at: 0, ok: null, error: "", pushed: 0, pulled: 0 };

/** 最近一次同步的状态快照。 */
export function cloudSyncState(): {
  at: number;
  ok: boolean | null;
  error: string;
  pushed: number;
  pulled: number;
} {
  return { ...state };
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncInFlight = false;

/**
 * 请求一次静默同步：防抖 3 秒（合并启动 + 每轮对话完成的高频触发）。
 * 任何异常都不会抛出——调用点可以放心地 `scheduleCloudSync("...")`。
 */
export function scheduleCloudSync(reason?: string): void {
  try {
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void syncCloudNow().catch((e) => {
        console.warn("[DS娘·云同步] 同步失败（已静默）:", reason ?? "", e);
      });
    }, 3000);
  } catch (e) {
    console.warn("[DS娘·云同步] 排程失败（忽略）:", e);
  }
}

// ─── 合并工具 ───

/** 按 id 去重合并：本地优先，云端独有的补在后面（不覆盖本地已有项）。 */
function mergeById<T>(localItems: T[], cloudItems: T[], idOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of localItems) {
    const key = idOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  for (const item of cloudItems) {
    const key = idOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ─── 旧版记忆 → MemoryBank 段落（一次性导入） ───

/**
 * 一次性导入标记：值为云端数据的指纹（`bank.notes.length-facts.length`）。
 * 指纹相同 ⇒ 已经导过，跳过；指纹变了（云端又有新数据）才重导。
 * 后端 `ds_import_memory_sections` 本身也按行去重，重导不会堆积。
 */
const LEGACY_IMPORT_KEY = "ds_legacy_mem_imported";

/** 去掉首尾空白并丢弃空行；非字符串元素（云端偶尔混入对象）直接跳过。 */
function splitLines(text: string): string[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `{major: "…", hobby: "…"}` → `- 键：值`（跳过空值）。 */
function objectToLines(source: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(source || {})) {
    const name = String(key ?? "").trim();
    if (!name) continue;
    const text =
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    if (!text.trim()) continue;
    out.push(`- ${name}：${text.trim()}`);
  }
  return out;
}

/**
 * 把云端「旧版记忆」组装成 MemoryBank 段落文本。
 *
 * **按段落容量分配**（这是关键）：
 * - `user_info`（默认上限 800 字符）← `bank.profile` + 旧字段 `user`（量小）
 * - `long_term`（默认上限 2000 字符）← 旧字段 `facts` + `people` + `bank.notes`
 *   实测：48 条笔记 + 33 条事实 + 4 人 ≈ 1.7k 字符，正好落在 long_term 里；
 *   若按最初规格塞进 user_info，会被 800 字符上限截掉大半。
 *
 * 顺序上**越重要的越靠后**——Rust 侧合并遇超限时优先保留新并入的靠后行，因此笔记放最后。
 * 两段都为空时返回 `null`（调用方据此跳过，不做无意义的导入）。
 */
function buildLegacySections(
  memory: CloudMemory | null | undefined
): Record<string, string> | null {
  const bank = memory?.bank || {};

  // ① user_info：画像 + 旧字段 user（都很短）
  const userInfoLines: string[] = [];
  userInfoLines.push(...objectToLines(bank.profile));
  userInfoLines.push(...objectToLines(memory?.user));

  // ② long_term：事实 → 人物 → 笔记（顺序 = 重要性递增）
  const longTermLines: string[] = [];

  const facts = Array.isArray(memory?.facts) ? (memory?.facts as unknown[]) : [];
  for (const fact of facts) {
    const text =
      typeof fact === "string" ? fact : String((fact as { text?: unknown })?.text ?? "");
    const trimmed = text.trim();
    if (trimmed) longTermLines.push(`- ${trimmed}`);
  }

  for (const [name, raw] of Object.entries(memory?.people || {})) {
    const who = String(name || "").trim();
    if (!who) continue;
    const entry = (raw || {}) as { relation?: unknown; info?: unknown };
    const relation = entry.relation ? String(entry.relation).trim() : "";
    const details = (Array.isArray(entry.info) ? entry.info : [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
    const suffix = details.length > 0 ? `：${details.join("；")}` : "";
    longTermLines.push(`- ${who}${relation ? `（${relation}）` : ""}${suffix}`);
  }

  const notes = Array.isArray(bank.notes) ? bank.notes : [];
  for (const note of notes) {
    const content = String(note?.content ?? "").trim();
    if (content) longTermLines.push(`- ${content}`);
  }

  const userInfo = splitLines(userInfoLines.join("\n")).join("\n");
  const longTerm = splitLines(longTermLines.join("\n")).join("\n");

  const sections: Record<string, string> = {};
  if (userInfo) sections.user_info = userInfo;
  if (longTerm) sections.long_term = longTerm;
  return Object.keys(sections).length > 0 ? sections : null;
}

/**
 * 把云端返回的旧版记忆**一次性**并入 MemoryBank 段落，让它从此每轮自动注入。
 *
 * 幂等：`localStorage[ds_legacy_mem_imported]` 存云端数据指纹，相同则直接跳过。
 * 静默：任何失败（含 Rust 侧报错）只 `console.warn`，绝不抛、绝不弹通知——
 * 调用点同步失败不会影响聊天（与本文件顶部「铁律」一致）。
 */
async function importLegacyMemory(memory: CloudMemory | null | undefined): Promise<void> {
  try {
    const notesCount = memory?.bank?.notes?.length ?? 0;
    const factsCount = memory?.facts?.length ?? 0;
    const fingerprint = `${notesCount}-${factsCount}`;
    if (localStorage.getItem(LEGACY_IMPORT_KEY) === fingerprint) return;

    const sections = buildLegacySections(memory);
    if (!sections) return;

    const res = (await invoke("ds_import_memory_sections", { sections })) as
      | { persisted?: boolean }
      | null;
    // 只有真正落盘才记指纹：若此刻还没有存档槽（persisted=false），内容只在内存里、
    // 重启会丢；不记指纹，等下次同步（有存档后）再导一次。
    if (res && res.persisted === false) {
      console.warn("[DS娘·云同步] 旧版记忆已写入内存但未落盘（暂无存档槽），下次同步会重试");
      return;
    }
    localStorage.setItem(LEGACY_IMPORT_KEY, fingerprint);
    console.log("[DS娘·云同步] 旧版记忆已并入 MemoryBank 段落:", fingerprint);
  } catch (e) {
    console.warn("[DS娘·云同步] 旧版记忆导入失败（已静默，不影响聊天）:", e);
  }
}

// ─── 手动笔记：本地 ⇄ bank.notes ───

/** 本地笔记 → bank.notes（tags[0] → tag，created_at → time） */
function toCloudNotes(local: LocalNote[]): CloudNote[] {
  return local.map((n) => ({
    id: String(n.id),
    content: String(n.content ?? ""),
    ...(Array.isArray(n.tags) && n.tags.length > 0 ? { tag: String(n.tags[0]) } : {}),
    ...(n.created_at ? { time: String(n.created_at) } : {}),
  }));
}

/** bank.notes → 本地笔记（tag → tags[0]，time → created_at） */
function toLocalNotes(cloud: CloudNote[]): LocalNote[] {
  return cloud.map((n) => ({
    id: String(n.id),
    content: String(n.content ?? ""),
    tags: n.tag ? [String(n.tag)] : [],
    created_at: n.time ? String(n.time) : new Date().toISOString(),
  }));
}

/**
 * 合并笔记：本地优先，云端独有的补进来。
 * 返回合并结果（待整体写回本地并发送给云端，让两端收敛到同一个并集）。
 */
async function mergeNotes(cloudNotes: CloudNote[]): Promise<LocalNote[]> {
  let local: LocalNote[] = [];
  const raw = await invoke<unknown>("ds_get_notes");
  if (Array.isArray(raw)) local = raw as LocalNote[];
  const merged = mergeById<CloudNote>(
    toCloudNotes(local),
    Array.isArray(cloudNotes) ? cloudNotes : [],
    (n) => String(n.id)
  );
  return toLocalNotes(merged);
}

/** 把合并后的笔记写回本地（结构转回 {id, content, tags, created_at}）。 */
async function writeLocalNotes(notes: LocalNote[]): Promise<void> {
  await invoke("ds_set_notes", { notes });
}

// ─── 待办：本地 todoGroups ⇄ bank.schedule ───

/** 展平本地 todoGroups → bank.schedule（分组名写进 group，便于 pull 时还原） */
function flattenTodos(todoGroups: Record<string, LocalTodoGroup>): CloudSchedule[] {
  const out: CloudSchedule[] = [];
  for (const [groupId, group] of Object.entries(todoGroups || {})) {
    const todos = Array.isArray(group?.todos) ? group.todos : [];
    for (const todo of todos) {
      const id = String(todo.id);
      out.push({
        id,
        content: String(todo.text ?? ""),
        status: todo.completed ? "done" : "todo",
        importance: Math.round(toNumber(todo.priority, 0)),
        ...(todo.deadline ? { date: String(todo.deadline) } : {}),
        // 提醒时间总是带上（空字符串=没有提醒）：Worker 靠"字段是否存在"区分
        // "用户清掉了提醒"和"老客户端根本没这个字段"
        remindAt: String(todo.remindAt ?? ""),
        group: groupId,
      });
    }
  }
  return out;
}

/** bank.schedule → 本地 todoGroups（按 group 分回；本地已有分组名保持不变，缺失的分组新建） */
function groupSchedules(
  schedule: CloudSchedule[],
  base: Record<string, LocalTodoGroup>
): Record<string, LocalTodoGroup> {
  // 先放一份本地分组（title/description 等字段原样保留）
  const groups: Record<string, LocalTodoGroup> = {};
  for (const [groupId, group] of Object.entries(base || {})) {
    groups[groupId] = { ...group, todos: [] };
  }
  // 注意：**不能**把本地已有 id 预先塞进 takenIds。
  // 那样本地条目走到 pickId 时会发现自己"已被占用"，于是一律被重新编号，
  // 结果是每同步一次本地 id 全变、下一次 pull 就认不出云端那几条 → 待办不断翻倍
  // （`鲸鱼娘iOS/_diag/todo-id-stability-test.cjs` 复现：3 条 → 6 条）。
  // `merged` 是本地优先排好序的，本地条目先认领自己的 id，云端独有的再来分配即可。
  const takenIds = new Set<number>();
  let nextId = 1;
  const pickId = (raw: unknown): number => {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && !takenIds.has(n)) {
      takenIds.add(n);
      return n;
    }
    while (takenIds.has(nextId)) nextId += 1;
    const assigned = nextId;
    takenIds.add(assigned);
    nextId += 1;
    return assigned;
  };

  for (const item of schedule || []) {
    const groupId = String(item?.group || "default");
    if (!groups[groupId]) groups[groupId] = { title: groupId, todos: [] };
    const todo: LocalTodo = {
      id: pickId(item?.id),
      text: String(item?.content ?? ""),
      priority: Math.round(toNumber(item?.importance, 0)),
      completed: item?.status === "done",
    };
    if (item?.date) todo.deadline = String(item.date);
    // 云端没有这个字段时保留本地值（mergeById 是本地优先，本地条目本来就带着 remindAt）
    if (item?.remindAt) todo.remindAt = String(item.remindAt);
    groups[groupId].todos.push(todo);
  }
  return groups;
}

/** 待办去重的一次性修复标记 */
const TODO_DEDUPE_FLAG = "ds_todo_dedupe_v1";

/**
 * 一次性修复历史损伤：旧版 `groupSchedules` 会给本地待办重新编号，于是每同步一次
 * 本地就多出一份完全相同的待办。这里把"内容/优先级/完成态/截止/提醒"完全相同的重复项各留一条。
 * 只跑一次（localStorage 标记），避免误删用户刻意建的相同待办。
 */
function dedupeLocalTodosOnce(base: Record<string, LocalTodoGroup>): {
  groups: Record<string, LocalTodoGroup>;
  removed: number;
} {
  if (localStorage.getItem(TODO_DEDUPE_FLAG) === "1") return { groups: base, removed: 0 };
  let removed = 0;
  const groups: Record<string, LocalTodoGroup> = {};
  for (const [groupId, group] of Object.entries(base || {})) {
    const seen = new Set<string>();
    const todos: LocalTodo[] = [];
    for (const todo of group?.todos || []) {
      const key = [
        String(todo?.text ?? ""),
        String(todo?.priority ?? ""),
        todo?.completed ? "1" : "0",
        String(todo?.deadline ?? ""),
        String(todo?.remindAt ?? ""),
      ].join("\u0001");
      if (seen.has(key)) {
        removed += 1;
        continue;
      }
      seen.add(key);
      todos.push(todo);
    }
    groups[groupId] = { ...group, todos };
  }
  localStorage.setItem(TODO_DEDUPE_FLAG, "1");
  if (removed > 0) {
    console.warn(`[DS娘·云同步] 清理历史重复待办 ${removed} 条（旧版同步逻辑会把待办复制一份）`);
  }
  return { groups, removed };
}

/**
 * 合并待办：本地优先，云端独有（按 id 判断）的补进来；
 * 顺带记录云端带来的新条目数（pulled）。
 */
function mergeTodos(cloudSchedule: CloudSchedule[]) {
  const cloudList = Array.isArray(cloudSchedule) ? cloudSchedule : [];
  return getSchedules().then((local) => {
    const { groups: base, removed } = dedupeLocalTodosOnce(
      (local?.todoGroups || {}) as Record<string, LocalTodoGroup>
    );
    const localFlat = flattenTodos(base);
    const merged = mergeById<CloudSchedule>(localFlat, cloudList, (item) => String(item.id));
    const added = merged.length - localFlat.length;
    return {
      groups: groupSchedules(merged, base),
      total: merged.length,
      /** 云端独有、被补进本地的条数 */
      added: added > 0 ? added : 0,
      /** 顺手清掉的历史重复条数（只会有一次） */
      removed,
    };
  });
}

// ─── 日志：本地 ds_chat_log ⇄ bank.logs ───

/** 把云端日志规整成本地形状（丢掉不认识的结构，保证 localStorage 里形状干净） */
function normalizeCloudLogs(cloudLogs: unknown): ChatLogEntry[] {
  if (!Array.isArray(cloudLogs)) return [];
  const out: ChatLogEntry[] = [];
  for (const raw of cloudLogs) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const t = toNumber(item.t, 0);
    const role = item.role;
    if (
      !Number.isFinite(t) ||
      t <= 0 ||
      (role !== "user" && role !== "ai" && role !== "action") ||
      typeof item.text !== "string"
    ) {
      continue;
    }
    const entry: ChatLogEntry = { t, role, text: item.text };
    if (item.emotion !== undefined) entry.emotion = String(item.emotion);
    if (item.seq !== undefined && Number.isFinite(Number(item.seq))) entry.seq = Number(item.seq);
    out.push(entry);
  }
  return out;
}

/** 日志合并：按 t 去重，本地优先；返回合并后的有序列表。 */
function mergeLogs(cloudLogs: unknown): ChatLogEntry[] {
  const local = exportChatLog();
  const cloud = normalizeCloudLogs(cloudLogs);
  return mergeById<ChatLogEntry>(local, cloud, (entry) => String(entry.t)).sort((a, b) => a.t - b.t);
}

// ─── 主流程 ───

/**
 * 立即执行一次静默云同步（正常情况下请用 `scheduleCloudSync` 走防抖）。
 * 永不抛出：所有失败都写进返回值与 `cloudSyncState()`。
 */
export async function syncCloudNow(): Promise<{
  ok: boolean;
  error?: string;
  pushed?: number;
  pulled?: number;
}> {
  let error = "";
  let pushed = 0;
  let pulled = 0;
  let ok = false;

  try {
    if (syncInFlight) {
      error = "上一次同步仍在进行中";
      return { ok: false, error };
    }
    syncInFlight = true;

    const cfg = await loadCloudSettings();
    if (!cfg.enabled) {
      state.at = Date.now();
      state.ok = null;
      state.error = "";
      return { ok: false, error: "云同步已关闭或未配置令牌" };
    }

    // 1) 采集本地数据（三段互相独立：某一段拿不到不影响其它段）
    let localNotes: LocalNote[] = [];
    try {
      localNotes = await mergeNotes([]);
    } catch (e) {
      // 例如刚启动还没选角色：跳过笔记这一段，待办/日志照常同步。
      console.warn("[DS娘·云同步] 读取本地笔记失败，跳过记忆同步:", e);
    }

    let localTodoGroups: Record<string, LocalTodoGroup> = {};
    try {
      const localTodos = await mergeTodos([]);
      localTodoGroups = localTodos.groups;
    } catch (e) {
      console.warn("[DS娘·云同步] 读取本地待办失败，跳过待办同步:", e);
    }

    let logs: ChatLogEntry[] = [];
    try {
      logs = exportChatLog();
    } catch (e) {
      console.warn("[DS娘·云同步] 读取本地日志失败，跳过日志同步:", e);
    }

    // 2) 组装并推送（PUT {url}/api/memory）
    const memory: CloudMemory = {
      bank: {
        notes: toCloudNotes(localNotes),
        profile: {},
        schedule: flattenTodos(localTodoGroups),
      },
      summary: "",
      diary: {},
      logs: logs as unknown as Array<Record<string, unknown>>,
    };
    pushed = (memory.bank?.notes?.length || 0) + (memory.bank?.schedule?.length || 0) + logs.length;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let resp: Response;
    try {
      resp = await fetch(`${cfg.url}/api/memory`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Whale-Token": cfg.token,
        },
        body: JSON.stringify({ memory }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { ok?: boolean; memory?: CloudMemory } | null;
    if (!data || typeof data !== "object" || data.ok !== true) {
      throw new Error("云端返回异常（ok !== true）");
    }
    const remote: CloudMemory =
      data.memory && typeof data.memory === "object" ? data.memory : {};

    // 3) Pull：把云端权威结果合并回本地（本地优先，云端独有的补进来）
    let mergedNotes = localNotes;
    try {
      mergedNotes = await mergeNotes(remote.bank?.notes || []);
      if (mergedNotes.length > localNotes.length) pulled += mergedNotes.length - localNotes.length;
      await writeLocalNotes(mergedNotes);
    } catch (e) {
      console.warn("[DS娘·云同步] 合并/写回本地笔记失败（不影响聊天）:", e);
    }

    try {
      const mergedTodos = await mergeTodos(remote.bank?.schedule || []);
      pulled += mergedTodos.added;
      await saveSchedules({ todoGroups: mergedTodos.groups });
    } catch (e) {
      console.warn("[DS娘·云同步] 合并/写回本地待办失败（不影响聊天）:", e);
    }

    try {
      const mergedLogs = mergeLogs(remote.logs);
      if (mergedLogs.length > logs.length) pulled += mergedLogs.length - logs.length;
      if (mergedLogs.length !== logs.length) replaceChatLog(mergedLogs);
    } catch (e) {
      console.warn("[DS娘·云同步] 合并/写回本地日志失败（不影响聊天）:", e);
    }

    // 4) Pull 之后：把云端那份「旧版记忆」一次性翻译成 MemoryBank 段落，
    //    让它在**每一轮对话**里自动注入（内部自带 localStorage 指纹与 try/catch，
    //    已导过就跳过、失败只 warn，不影响这里的 ok 判定）。
    await importLegacyMemory(remote);

    ok = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.warn("[DS娘·云同步] 同步失败（已静默，不影响聊天）:", e);
  } finally {
    syncInFlight = false;
    state.at = Date.now();
    state.ok = ok;
    state.error = error;
    state.pushed = pushed;
    state.pulled = pulled;
  }

  return ok ? { ok, pushed, pulled } : { ok: false, error };
}
