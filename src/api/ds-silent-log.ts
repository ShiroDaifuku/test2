/**
 * DS娘 v0.4 · 静默对话日志（含时间戳）
 *
 * 需求：日志与时间戳是独立版自有能力，"继续启用但静默运行，暂不在 UI 上做加法"。
 * 因此这里只做本地记录，不新增任何界面；需要时可通过 exportChatLog() 取出来。
 *
 * 存储：localStorage（key: ds_chat_log），数组形式，保留最近 MAX 条。
 * 记录时机：由 dialogue-processor（AI 台词）与 GameDialog（用户输入）各调用一次 recordChat。
 */

const KEY = "ds_chat_log";
const MAX = 2000;

export interface ChatLogEntry {
  /** 毫秒时间戳 */
  t: number;
  /** 说话人：user | ai | action（动作描写） */
  role: "user" | "ai" | "action";
  /** 台词或动作文本 */
  text: string;
  /** 情绪标签（AI 台词才有） */
  emotion?: string;
  /** 本轮第几句（可选，便于还原顺序） */
  seq?: number;
}

function readAll(): ChatLogEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as ChatLogEntry[]) : [];
  } catch (e) {
    return [];
  }
}

function writeAll(list: ChatLogEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) {
    // 配额满等情况：丢一半最旧的，保最近记录
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(-Math.floor(MAX / 2))));
    } catch (e2) {
      /* 放弃写入，不影响对话 */
    }
  }
}

/** 记录一条。任何异常都吞掉——日志绝不能影响聊天。 */
export function recordChat(entry: Omit<ChatLogEntry, "t"> & { t?: number }): void {
  try {
    const list = readAll();
    list.push({ t: entry.t ?? Date.now(), role: entry.role, text: entry.text, emotion: entry.emotion, seq: entry.seq });
    writeAll(list.length > MAX ? list.slice(-MAX) : list);
  } catch (e) {
    /* 忽略 */
  }
}

/** 取出全部记录（供导出/调试；不在 UI 暴露） */
export function exportChatLog(): ChatLogEntry[] {
  return readAll();
}

/** 条数与首末时间（供自检） */
export function chatLogState(): { count: number; first: number; last: number } {
  const list = readAll();
  return { count: list.length, first: list[0]?.t ?? 0, last: list[list.length - 1]?.t ?? 0 };
}

/**
 * 覆盖写入整份日志（DS娘 v0.4 静默云同步 pull 合并结果回写用）。
 *
 * 与 `recordChat` 一样，任何异常都吞掉——日志与同步都绝不能影响聊天。
 * 仍遵守 MAX 上限：只保留最近 MAX 条。
 */
export function replaceChatLog(list: ChatLogEntry[]): void {
  try {
    if (!Array.isArray(list)) return;
    writeAll(list.length > MAX ? list.slice(-MAX) : list);
  } catch (e) {
    /* 忽略 */
  }
}
