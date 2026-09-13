/**
 * DS娘 v0.4 · 情绪兜底（自训练小模型）
 *
 * 现状：LLM 输出 `【情绪】台词` → Rust `normalize_emotion_tag` 关键词表归一化 → 前端
 * `EMOTION_CONFIG_EMO` 映射立绘；关键词表认不出时会被归一成「正常」，情绪就丢了。
 *
 * 这里补一条兜底链：关键词表命中 → 直接用；没命中 → 本地小模型对整句台词预测 → 还认不出 → 「正常」。
 *
 * 三条硬约束：
 * 1. 默认开启，可在设置里关（设置项 `ds.emotion_fallback`，Rust 侧已注册，默认 true）；
 *    读设置失败也按「开启」处理——不能因为一次配置读不到就悄悄把功能关掉。
 * 2. 832KB 的小模型必须按需加载（动态 import），绝不进主 chunk；设置关掉时连加载都不会发生。
 * 3. 任何异常（读设置、加载模型、预测）都退化成「正常」，绝不允许影响正常对话。
 */

import { getEnvConfigByKey } from "@/api/services/config";
import { EMOTION_CONFIG_EMO } from "@/controllers/emotion/config";
import type { SmallEmotionModel } from "@/lib/emotion-small";

/** 设置项键名（后端返回的 value 是字符串 "true"/"false"） */
const SETTING_KEY = "ds.emotion_fallback";

/**
 * 最低置信度：低于这个概率宁可回退「正常」，也不要瞎猜一个情绪出来。
 * 0.35 是小模型验证集上「低于此值准确率明显塌陷」的经验阈值。
 */
const MIN_PROB = 0.35;

/** 标签清洗：去掉空白、方括号以及中英文常见标点（原始标签可能带【】和句读） */
const TAG_NOISE_RE = /[\s【】，,。.！!？?…~～]/g;

/**
 * 设置缓存：模块级。undefined = 还没读过；读到结果后就一直用缓存。
 * 读失败不写缓存（返回 true），这样后端稍后就绪时下一次还能读到真实值。
 * 设置面板保存后由 invalidateDsEmotionSetting() 清缓存。
 */
let cachedEnabled: boolean | undefined = undefined;

/** 模型单例：只在第一次真正需要兜底时创建；null 表示加载/初始化失败，不重试（避免每句都抛异常） */
let modelPromise: Promise<SmallEmotionModel | null> | null = null;

/** 清洗情绪标签：只保留文字，去掉标记与标点 */
function cleanTag(tag: string | undefined): string {
  return (tag || "").replace(TAG_NOISE_RE, "").trim();
}

/**
 * 兜底功能是否开启。
 * 首次读取后缓存；读取失败默认 true（宁可多算一次，也不因为读配置失败就丢情绪）。
 */
export async function dsEmotionFallbackEnabled(): Promise<boolean> {
  if (cachedEnabled !== undefined) return cachedEnabled;
  try {
    const item = await getEnvConfigByKey(SETTING_KEY);
    // 只有明确写成 false/0/off/no 才算关闭；空值/异常值一律按默认开启处理（默认 true 是需求）
    const raw = String(item?.value ?? "")
      .trim()
      .toLowerCase();
    const enabled = !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
    cachedEnabled = enabled;
    return enabled;
  } catch (e) {
    // 读设置失败（非 Tauri 环境、命令未注册等）：默认开启，且不写缓存以便下次重试
    console.warn("[ds-emotion] 读取情绪兜底设置失败，按默认开启处理：", e);
    return true;
  }
}

/** 设置保存后调用：清掉缓存，使新开关立即生效 */
export function invalidateDsEmotionSetting(): void {
  cachedEnabled = undefined;
}

/** 懒加载模型（模块级单例）。动态 import 保证 832KB 权重只有在真的要兜底时才被拉取。 */
function getModel(): Promise<SmallEmotionModel | null> {
  if (!modelPromise) {
    modelPromise = import("@/lib/emotion-small")
      .then((mod) => mod.createEmotionModel())
      .catch((e) => {
        // 加载或初始化失败：缓存 null，兜底链退化为「无兜底」，不影响对话
        console.warn("[ds-emotion] 小模型加载失败，情绪兜底停用：", e);
        return null;
      });
  }
  return modelPromise;
}

/**
 * 用小模型猜情绪。
 * 只返回前端认识的标签（EMOTION_CONFIG_EMO 里有键），否则 null——避免把立绘映射不了的类别透传下去。
 * 置信度不足或任何异常一律 null。
 */
export async function guessEmotionBySmallModel(text: string): Promise<string | null> {
  try {
    if (!text) return null;
    const model = await getModel();
    if (!model) return null;
    const result = model.predict(text);
    const label = result?.label;
    if (!label) return null;
    // 只接受前端已知标签（含「正常」「平静」：这两个虽然等于没情绪，但返回它们与回退「正常」等价）
    if (!(label in EMOTION_CONFIG_EMO)) return null;
    // 置信度太低就当作没猜出来
    if (typeof result.prob === "number" && result.prob < MIN_PROB) return null;
    return label;
  } catch (e) {
    console.warn("[ds-emotion] 小模型预测异常，本次不兜底：", e);
    return null;
  }
}

/**
 * 情绪解析（兜底链的唯一入口），严格按以下顺序：
 * 1. 关键词表命中（rustTag 非空且不是「正常」）→ 直接用它，旧逻辑不动
 * 2. 设置里关掉了兜底 → 「正常」
 * 3. 原始标签清洗后为空或就是「正常」→ 这句话本来没有情绪，「正常」
 * 4. 小模型对整句台词预测（取不到台词就用清洗后的标签）→ 有结果就用
 * 5. 都不行 → 「正常」
 */
export async function resolveEmotion(
  rustTag: string | undefined,
  originalTag: string | undefined,
  message: string | undefined
): Promise<string> {
  // 1) 关键词表已经认出来了，不介入、不改写
  if (rustTag && rustTag !== "正常") return rustTag;

  // 2) 用户在设置里关掉了兜底，维持原行为
  if (!(await dsEmotionFallbackEnabled())) return "正常";

  // 3) 原始标签本来就是空/正常 → 不需要兜底
  const cleaned = cleanTag(originalTag);
  if (!cleaned || cleaned === "正常") return "正常";

  // 4) 小模型兜底：优先用整句台词（n-gram 模型看整句比看标签准），拿不到台词再退回标签
  const guessed = await guessEmotionBySmallModel(message && message.trim() ? message : cleaned);
  if (guessed) return guessed;

  // 5) 兜底也认不出 → 正常
  return "正常";
}
