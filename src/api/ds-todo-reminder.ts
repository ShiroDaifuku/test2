/**
 * DS娘 v0.4 · 待办到点提醒（系统级通知）
 *
 * 数据来源：`schedules.json` 里的待办（`TodoItem.remindAt`，本地时间 `YYYY-MM-DD HH:MM`），
 * 由 `schedule_add_todo` / `schedule_update_todo` 工具写入（模型按用户口述推测时间），
 * 也可以在待办面板里手填。到点由系统弹通知，应用在后台/被挂起也收得到。
 *
 * 与番茄钟（`PomodoroPanel.vue`）同一套机制：`tauri-plugin-notification` 的 `Schedule.at()`。
 *
 * 重排时机：
 *   - 应用启动
 *   - Rust 侧待办被 AI 改动 → 事件 `ds:todos_changed`
 *   - 待办面板保存（同样会触发上面那个事件？不会——面板走 `save_schedules`，所以这里额外
 *     监听窗口重新可见 + 每 5 分钟兜底一次）
 *   - 窗口重新可见（切回前台）
 *
 * 通知 id 段：`TODO_NOTIFY_BASE + todoId`（番茄钟用 98001，这里从 100000 起，互不干扰）。
 */
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  cancel,
  pending,
  Schedule,
  type PendingNotification,
} from "@tauri-apps/plugin-notification";
import { i18n } from "@/locales";
import { getSchedules } from "@/api/services/schedule";

/** 本模块排定的通知 id 起点（>= 这个值的一律视为"待办提醒"） */
const TODO_NOTIFY_BASE = 100000;
/** 兜底重排间隔 */
const RESYNC_INTERVAL_MS = 5 * 60 * 1000;

interface LocalTodo {
  id?: number | string;
  text?: string;
  completed?: boolean;
  remindAt?: string;
}

let started = false;
let permission: boolean | null = null;
let syncing = false;
let queued = false;

/** 解析本地时间字符串（不用 Date.parse："YYYY-MM-DD HH:MM" 在各引擎上解释不一致） */
function parseLocalDateTime(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(raw).trim());
  if (!m) return null;
  const at = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    0,
    0
  ).getTime();
  return Number.isFinite(at) ? at : null;
}

async function ensurePermission(): Promise<boolean> {
  if (permission !== null) return permission;
  try {
    permission = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch (e) {
    console.warn("[待办提醒] 通知权限检查失败:", e);
    permission = false;
  }
  return permission;
}

/** 收集"未完成 + 有未来提醒时间"的待办 */
async function collectWanted(): Promise<Map<number, { at: number; text: string }>> {
  const wanted = new Map<number, { at: number; text: string }>();
  const data = await getSchedules();
  const groups = (data?.todoGroups || {}) as Record<string, { todos?: LocalTodo[] }>;
  const now = Date.now();
  for (const group of Object.values(groups)) {
    for (const todo of group?.todos || []) {
      if (!todo || todo.completed) continue;
      const id = Math.trunc(Number(todo.id));
      if (!Number.isFinite(id)) continue;
      const at = todo.remindAt ? parseLocalDateTime(String(todo.remindAt)) : null;
      if (at === null || at <= now) continue; // 没设提醒 / 已经过了
      wanted.set(id, { at, text: String(todo.text ?? "").trim() || i18n.global.t("ui.todoPage.taskFallback") });
    }
  }
  return wanted;
}

/** 取消本模块排定的全部待发通知（只动 id >= TODO_NOTIFY_BASE 的那些） */
async function cancelOurPending(): Promise<void> {
  try {
    const waiting = (await pending()) as PendingNotification[];
    const ours = waiting.filter((n) => Number(n.id) >= TODO_NOTIFY_BASE).map((n) => Number(n.id));
    if (ours.length) await cancel(ours);
  } catch (e) {
    console.warn("[待办提醒] 取消旧通知失败:", e);
  }
}

/**
 * 重排全部待办提醒：先撤掉本模块排过的，再按当前数据排一遍。
 * 整体重排（而不是增量对比）是为了让"改了提醒时间"这种情况立刻生效。
 */
export async function syncTodoReminders(): Promise<void> {
  if (syncing) {
    queued = true;
    return;
  }
  syncing = true;
  try {
    const wanted = await collectWanted();
    await cancelOurPending();
    if (wanted.size === 0) return;
    if (!(await ensurePermission())) return;
    const title = i18n.global.t("ui.todoPage.remindNotifyTitle");
    for (const [id, item] of wanted) {
      sendNotification({
        id: TODO_NOTIFY_BASE + id,
        title,
        body: item.text,
        schedule: Schedule.at(new Date(item.at)),
      });
    }
    console.log(`[待办提醒] 已排定 ${wanted.size} 条到点通知`);
  } catch (e) {
    console.warn("[待办提醒] 重排失败（不影响其它功能）:", e);
  } finally {
    syncing = false;
    if (queued) {
      queued = false;
      void syncTodoReminders();
    }
  }
}

/** 启动待办提醒：事件监听 + 启动同步 + 兜底轮询。重复调用无副作用。 */
export function initTodoReminders(): void {
  if (started) return;
  started = true;

  // AI 通过工具改动待办后，Rust 会广播这个事件（见 tools/schedule.rs::emit_todos_changed）
  void listen("ds:todos_changed", () => {
    void syncTodoReminders();
  }).catch((e) => console.warn("[待办提醒] 监听待办变更事件失败:", e));

  // 待办面板是前端直接 save_schedules 的，没有事件；切回前台时补一次
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncTodoReminders();
  });

  // 兜底：定时重排（同时负责把已经过去的通知清掉）
  window.setInterval(() => void syncTodoReminders(), RESYNC_INTERVAL_MS);

  void syncTodoReminders();
}
