import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { eventQueue } from "../core/events/event-queue";
import type { ScriptEventType } from "../types";
import { useUIStore } from "../stores/modules/ui/ui";
import { useGameStore } from "../stores/modules/game";
import { i18n } from "@/locales";
import {
  clearToolCallPreparing,
  handleToolActivity,
  handleToolCallProgress,
  interruptToolActivities,
  pushToolCallRecord,
  toolDisplayName,
  type ToolActivityEvent,
} from "./services/tool-settings";
import { useDialogStore } from "../stores/modules/ui/dialog";
import type { SceneInfo } from "./services/scene";

function asEvent(
  payload: unknown,
  defaults: { type: string; defaultDuration: number; isFinal?: boolean }
): ScriptEventType {
  const p = payload as Record<string, unknown>;
  // 优先用引擎从 YAML 读到的 duration；没写才用各事件类型的默认值。
  // 默认值语义：-1 = 等玩家点击继续；0 = 立即继续（不等待）。
  const duration = typeof p.duration === "number" ? p.duration : defaults.defaultDuration;
  return {
    ...p,
    type: defaults.type,
    duration,
    ...(defaults.isFinal !== undefined ? { isFinal: defaults.isFinal } : {}),
  } as unknown as ScriptEventType;
}

export function initializeTauriEventListeners() {
  const currentWindow = getCurrentWindow();
  const mainWindow = currentWindow.label === "main" ? currentWindow : null;

  listen("ai:reply", (event) => {
    const payload = event.payload as Record<string, unknown>;
    console.log("[Tauri] ai:reply", event.payload);
    eventQueue.addEvent(asEvent(payload, { type: "reply", defaultDuration: -1 }));
  });

  listen("ai:thinking", (event) => {
    console.log("[Tauri] ai:thinking", event.payload);
    eventQueue.addEvent(asEvent(event.payload, { type: "thinking", defaultDuration: 0 }));
  });

  listen("ai:thinking_progress", (event) => {
    const payload = event.payload as { thinkingLength?: number };
    console.log("[Tauri] ai:thinking_progress", payload);
    const gameStore = useGameStore();
    if (typeof payload.thinkingLength === "number") {
      gameStore.thinkingLength = payload.thinkingLength;
    }
  });

  listen("ai:error", (event) => {
    const p = event.payload as Record<string, unknown>;
    console.log("[Tauri] ai:error", p);
    interruptToolActivities();
    eventQueue.addEvent({
      type: "error",
      duration: 0,
      error_code: (p.error_code as string) ?? "default_error",
      message: (p.detail as string) ?? "",
    } as ScriptEventType);
  });

  // 工具执行生命周期：驱动自由对话顶栏的实时状态，不写入历史记录。
  listen("ai:tool_activity", (event) => {
    const payload = event.payload as ToolActivityEvent;
    handleToolActivity(payload);
  });

  // 工具调用参数流式生成进度：顶栏实时显示「正在生成…N 字」
  listen("ai:tool_call_progress", (event) => {
    handleToolCallProgress(event.payload as { tool: string; chars: number });
  });

  // 一轮 LLM 流结束：清除「正在生成」进度提示（工具被忽略的收尾轮不会再有执行事件）
  listen("ai:tool_call_progress_end", () => {
    clearToolCallPreparing();
  });

  // 工具调用结果：记入「工具调用」页面历史 + 左上角弹通知
  listen("ai:tool_call", (event) => {
    const payload = event.payload as {
      tool: string;
      ok: boolean;
      summary: string;
      error: string | null;
      arguments: string;
      result: string;
    };
    pushToolCallRecord({
      ...payload,
      time: new Date().toLocaleTimeString(),
    });
    const toolLabel = toolDisplayName(payload.tool);
    const uiStore = useUIStore();
    if (payload.ok) {
      uiStore.showNotification({
        type: "success",
        title: i18n.global.t("ui.toolCalls.callSuccess"),
        message: `${toolLabel}：${payload.summary}`,
        duration: 3000,
        skipTipsCheck: true,
      });
    } else {
      uiStore.showNotification({
        type: "warning",
        title: i18n.global.t("ui.toolCalls.callFailed"),
        message: payload.error || toolLabel,
        duration: 4000,
        skipTipsCheck: true,
      });
    }
  });

  // 审批框只在主窗口挂载；独立日志窗口等不能消费审批事件。
  // 主聊天 execute_command 审批：弹确认框，把用户决定回传给等待中的工具

  // execute_command 中识别到删除操作时使用独立危险确认；回传到删除审批队列。

  // 逐次确认模式下，write_file / edit_file 在真正修改前显示目标路径。

  // 主聊天 delete_file 审批：先显示后端解析并校验过的真实路径，再把决定回传给工具。

  listen("status:reset", (event) => {
    console.log("[Tauri] status:reset", event.payload);
    eventQueue.addEvent(asEvent(event.payload, { type: "status_reset", defaultDuration: 0 }));
  });

  // === Auto-save events ===

  listen("save:auto-saved", async (event) => {
    const payload = event.payload as { save_id: number; title: string; timestamp: string };
    console.log("[Tauri] save:auto-saved", payload);

    // Capture screenshot for auto-save slot
    const gameStore = useGameStore();
    const screenshotPath = await gameStore.captureScreenshot();
    if (screenshotPath) {
      try {
        await invoke("save_screenshot", {
          saveId: payload.save_id,
          screenshotPath,
        });
      } catch (e) {
        console.error("[Tauri] Failed to save auto-save screenshot", e);
      }
    }

    useUIStore().showNotification({
      type: "info",
      title: i18n.global.t("api.events.autoSave.title"),
      message: i18n.global.t("api.events.autoSave.message", { time: payload.timestamp }),
      duration: 2500,
      skipTipsCheck: true,
    });
  });

  // === Script events ===

  // 环境音事件（多轨并行，与BGM共存）

  // === God Agent multi-dialogue event ===

  listen("character:switch", async (event) => {
    const payload = event.payload as { type: string; roleId: number; characterName: string };
    console.log("[Tauri] character:switch", payload);
    const gameStore = useGameStore();
    const uiStore = useUIStore();
    // 先确保角色数据已加载（立绘/名字都从这里取）
    const role = await gameStore.getOrCreateGameRole(payload.roleId);
    gameStore.currentInteractRoleId = payload.roleId;
    // 新角色不在场时才替换舞台（多人场景下 God Agent 只会选在场角色，不进这分支）；
    // 用替换而非 push，避免标准模式舞台出现两个角色、桌宠不生效
    if (!gameStore.presentRoleIds.includes(payload.roleId)) {
      gameStore.presentRoleIds = [payload.roleId];
    }
    // 同步主界面/桌宠标题（对话中名字由 currentInteractRole 驱动，已覆盖）
    uiStore.showCharacterTitle = role.roleName;
    uiStore.showCharacterSubtitle = role.roleSubTitle;
  });

  // === LLM 场景工具事件 ===

  console.log(
    "[Tauri] Event listeners initialized (ai + ai:thinking_progress + tts:cleanup + adventure + auto-save + 13 script events + character:switch + scene:switch)"
  );
}

/**
 * 投屏窗口专用的精简事件监听。
 *
 * 投屏窗口是独立的 webview，事件队列与主窗口各自独立。台词/标题/情绪
 * 完全由主窗口的镜像事件（cast:mirror，见 App.vue）驱动——若这里也注册
 * ai:reply 等会驱动队列的监听，投屏就会「按消息到达时间显示」而与主界面
 * 脱节。这里只注册投屏需要的即时状态事件：
 * - scene:switch / character:switch：背景、场景光照、立绘即时同步
 * （其余场景状态由 CastWindow 的 2s 快照对账兜底）。
 */
export function initializeCastWindowListeners() {
  listen("character:switch", async (event) => {
    const payload = event.payload as { type: string; roleId: number; characterName: string };
    const gameStore = useGameStore();
    const uiStore = useUIStore();
    const role = await gameStore.getOrCreateGameRole(payload.roleId);
    gameStore.currentInteractRoleId = payload.roleId;
    if (!gameStore.presentRoleIds.includes(payload.roleId)) {
      gameStore.presentRoleIds = [payload.roleId];
    }
    uiStore.showCharacterTitle = role.roleName;
    uiStore.showCharacterSubtitle = role.roleSubTitle;
  });

  // 投屏客户端麦克风经投屏 /ws 送到 Rust ASR，识别文本由这里注入对话。
  // 复用既有 asr-send 自定义事件 → GameDialog.onAsrAutoSend → send()（sendMessage）。
  // 仅投屏窗口注册此监听（主窗口不注册），保证每次识别恰好注入一次。

  console.log(
    "[Tauri] Cast window listeners initialized (scene:switch + character:switch + cast:mic:recognized)"
  );
}
