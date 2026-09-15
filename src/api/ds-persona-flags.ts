/**
 * DS娘 v0.4 · Persona Engine 功能开关（对齐任务书 §10：所有新模块必须能随时切回 baseline）
 *
 * 默认值 = **关闭**，因为这两项在 140 轮客观指标上是"混合结果"，
 * 需要人工盲评（`_diag/persona-eval/report/`）确认后再逐个打开：
 *   - dynamicState   ：心情/关系状态层（情绪标签驱动，零额外 API）
 *   - memoryRetrieval：检索式记忆注入（top-K 命中替换全量注入，省 ~3.4k tokens/轮）
 *
 * 打开方式（任一）：
 *   localStorage.setItem("ds_persona_flags", JSON.stringify({ dynamicState: true, memoryRetrieval: true }))
 * 或由后续版本把 DEFAULTS 改成 true。
 *
 * 人设提示词（settings.yml 里的情绪规则/示范/长度策略）不在此列——那部分已经用
 * LIVE 变体验证过（情绪合规 43%→98.6%），是默认生效的。
 */
export interface PersonaFlags {
  dynamicState: boolean;
  memoryRetrieval: boolean;
}

const STORAGE_KEY = "ds_persona_flags";

/** 默认值：等人工盲评后再改这里或写 localStorage 覆盖 */
const DEFAULTS: PersonaFlags = {
  dynamicState: false,
  memoryRetrieval: false,
};

export function personaFlag(name: keyof PersonaFlags): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const override = JSON.parse(raw) as Partial<PersonaFlags>;
      if (typeof override[name] === "boolean") return override[name] as boolean;
    }
  } catch {
    // 配置坏了就用默认值，绝不影响聊天
  }
  return DEFAULTS[name];
}

export function setPersonaFlag(name: keyof PersonaFlags, value: boolean): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const current = raw ? (JSON.parse(raw) as Partial<PersonaFlags>) : {};
    current[name] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch (e) {
    console.warn("[Persona 开关] 写入失败:", e);
  }
}

export function personaFlags(): PersonaFlags {
  return {
    dynamicState: personaFlag("dynamicState"),
    memoryRetrieval: personaFlag("memoryRetrieval"),
  };
}
