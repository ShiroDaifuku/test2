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

const DEFAULT_URL = "https://whale-girl-cloud.pages.dev";
/** CI 注入的兜底令牌（见 .github/workflows/build-ios.yml:75），本地未注入时为空 */
const ENV = (import.meta as unknown as { env?: Record<string, string> }).env || {};

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
  // 保证合法的数字 id：云端新建的待办 id 可能是非数字，退化为「当前最大 id + 1」
  const takenIds = new Set<number>();
  for (const group of Object.values(base || {})) {
    for (const todo of group?.todos || []) {
      const n = Number(todo.id);
      if (Number.isFinite(n)) takenIds.add(n);
    }
  }
  let nextId = 1;
  for (const value of takenIds) {
    if (value >= nextId) nextId = value + 1;
  }
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
    groups[groupId].todos.push(todo);
  }
  return groups;
}

/**
 * 合并待办：本地优先，云端独有（按 id 判断）的补进来；
 * 顺带记录云端带来的新条目数（pulled）。
 */
function mergeTodos(cloudSchedule: CloudSchedule[]) {
  const cloudList = Array.isArray(cloudSchedule) ? cloudSchedule : [];
  return getSchedules().then((local) => {
    const base = (local?.todoGroups || {}) as Record<string, LocalTodoGroup>;
    const localFlat = flattenTodos(base);
    const merged = mergeById<CloudSchedule>(localFlat, cloudList, (item) => String(item.id));
    const added = merged.length - localFlat.length;
    return {
      groups: groupSchedules(merged, base),
      total: merged.length,
      /** 云端独有、被补进本地的条数 */
      added: added > 0 ? added : 0,
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
