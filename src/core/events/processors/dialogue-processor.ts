import { invoke } from "@tauri-apps/api/core";
import type { IEventProcessor } from "../event-processor";
import type { ScriptDialogueEvent } from "../../../types";
import { useGameStore } from "../../../stores/modules/game";
import { useUIStore } from "../../../stores/modules/ui/ui";
import { isJaLocale, hkify } from "@/locales";
import { resolveEmotion } from "@/api/ds-emotion";
import { recordChat } from "@/api/ds-silent-log";
import { scheduleCloudSync } from "@/api/ds-cloud-sync";
import { updatePersonaStateAfterTurn } from "@/api/ds-persona-state";

/**
 * 本轮回复里出现的情绪标签（一次回复可能多句、每句一个标签）。
 * 收集到 `isFinal` 时一次性喂给状态层，避免同一轮被反复计入。
 */
let turnEmotions: string[] = [];

/** 取最近一条用户消息文本（状态层判断"他这句是什么情绪"要用） */
function lastUserText(gameStore: { dialogHistory: Array<{ type?: string; content?: string }> }): string {
  const history = gameStore.dialogHistory || [];
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.type === "message" && typeof message.content === "string") return message.content;
  }
  return "";
}

export default class DialogueProcessor implements IEventProcessor {
  canHandle(eventType: string): boolean {
    return eventType === "reply";
  }

  async processEvent(event: ScriptDialogueEvent): Promise<void> {
    const gameStore = useGameStore();
    const uiStore = useUIStore();

    // 更新游戏状态显示对话
    gameStore.currentStatus = "responding";

    // 针对剧本模式，获取角色
    const role = await gameStore.getOrCreateGameRole(event.roleId);
    if (!role) {
      console.warn("角色修改的角色似乎并没有被初始化");
      return;
    }

    const displayName = event.displayName ? event.displayName : role.roleName;
    const displaySubtitle = event.displaySubtitle ? event.displaySubtitle : role.roleSubTitle;

    // 情绪解析提前做一次：关键词表（Rust normalize_emotion_tag）命中就直接用，没命中时由本地小模型兜底，
    // 兜底也认不出才回退「正常」。结果在消息记录、立绘、展示标签三处共用，保证三者一致。
    // 放在角色校验之后：拿不到角色就直接 return，没必要为这一句去加载模型。
    const finalEmotion = await resolveEmotion(event.emotion, event.originalTag, event.message);
    // 兜底真正生效（解析结果与原标签不同）时，界面上的标签也要跟着立绘走，
    // 否则会出现「标签写着正常、立绘却在生气」的错位。
    const emotionFallbackApplied = finalEmotion !== event.emotion;

    // DS娘 v0.4 静默日志：AI 台词与动作都落本地（带时间戳），不新增任何界面
    // 记的是「最终情绪」（含小模型兜底结果），这样日志与当时界面上看到的立绘一致
    if (event.message) {
      recordChat({ role: "ai", text: event.message, emotion: finalEmotion, seq: event.userMessageSeq });
      // 状态层：只统计真正有台词的那几句的情绪
      turnEmotions.push(finalEmotion);
    } else if (event.motionText) {
      recordChat({ role: "action", text: event.motionText, seq: event.userMessageSeq });
    }

    // 日文界面且存在日语译文时显示日语译文；繁体（香港）界面下对话转繁体显示
    const displayLine = hkify(isJaLocale() && event.ttsText ? event.ttsText : event.message || "");
    gameStore.currentLine = displayLine;
    uiStore.showCharacterMotionText = event.motionText || "";

    gameStore.appendGameMessage({
      type: "reply",
      displayName: displayName,
      content: event.message,
      emotion: finalEmotion,
      audioFile: event.audioFile,
      isFinal: event.isFinal,
      motionText: event.motionText,
      originalTag: event.originalTag,
      userMessageSeq: event.userMessageSeq,
      thinking: event.thinking,
      ttsText: event.ttsText,
      senderRoleId: event.roleId,
    });

    // 回溯更新最近一条没有序号标记的用户消息（前端发送消息时尚未拿到序号）
    if (typeof event.userMessageSeq === "number") {
      const history = gameStore.dialogHistory;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].type === "message" && history[i].userMessageSeq === undefined) {
          history[i].userMessageSeq = event.userMessageSeq;
          break;
        }
      }
    }

    uiStore.showCharacterLine = gameStore.currentLine; // TODO: 这部分逻辑之后整合
    role.emotion = finalEmotion;
    role.originalEmotion = emotionFallbackApplied ? finalEmotion : event.originalTag || "正常";
    gameStore.currentInteractRoleId = role.roleId;
    uiStore.currentAvatarAudio = event.audioFile || "None";
    // 前端触发对话/播放回复音频时，把该句语音广播给投屏客户端（远端设备同步播放）。
    // 仅主窗口处理 ai:reply 事件，这里每句回复恰好执行一次；投屏服务未运行时命令内 no-op。
    if (event.audioFile) {
      invoke("cast_play_voice", { audioFile: event.audioFile }).catch(() => {});
    }
    // 兜底生效时展示标签也用最终情绪（此时 role.originalEmotion 已等于 finalEmotion），否则维持原样
    uiStore.showCharacterEmotion = emotionFallbackApplied ? finalEmotion : role.originalEmotion;

    uiStore.showCharacterTitle = displayName;
    uiStore.showCharacterSubtitle = displaySubtitle;
    // gameStore.currentCharacter = event.character;

    // DS娘 v0.4：本轮的收尾句到达 ⇒ 视为"一轮对话完成"，静默触发云同步
    // （scheduleCloudSync 内部 3 秒防抖 + 失败静默，绝不会打断对话）
    if (event.isFinal) {
      scheduleCloudSync("dialogue");
      // 状态层（P2）：用「他的消息 + 她这轮用到的情绪标签」推进心情/关系，
      // 内部走衰减 → 限幅(max_delta) → 钳位，并落盘 + 推给 Rust 供下一轮注入。
      const tags = turnEmotions.slice();
      turnEmotions = [];
      void updatePersonaStateAfterTurn({ userText: lastUserText(gameStore), emotionTags: tags });
    }

    // 对话总是等待用户继续，所以这里不需要做任何等待
    // event-queue 会自动检测到这是对话事件并等待用户继续
  }
}
