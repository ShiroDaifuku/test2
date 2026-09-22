/**
 * DS娘 v0.4 · Persona Engine 功能开关（对齐任务书 §10：所有新模块必须能随时切回 baseline）
 *
 * build6 默认只打开已经通过客观指标复核的动态状态层；记忆检索仍保持关闭，
 * 等人工盲评确认不会提高问句率和 AI 味后再单独放量：
 *   - dynamicState   ：心情/关系状态层（情绪标签驱动，零额外 API）
 *   - memoryRetrieval：检索式记忆注入（top-K 命中替换全量注入，省 ~3.4k tokens/轮）
 *
 * 设置入口：高级设置 → DS娘 → Persona Engine。也可用于调试：
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

/**
 * 默认值（依据 _diag/persona-eval 的 140 轮 × 2 种子 A/B 定）：
 *   - dynamicState = true ：描述式状态段把 AI 味命中从 0.30/千字降到 0.00，
 *                            末行建议率回到基线水平（8.7% vs 8.1%），情绪标签合规最高（99.45%），
 *                            末行问句率与基线持平（20.1% vs 19.5%）。
 *   - memoryRetrieval = false：检索每轮省 ~2.0k tokens（我们真实库 ≈2550 字符），
 *                            但会让末行问句率从 19.5% 涨到 27.6%、AI 味升到 0.59/千字；
 *                            K=8 也修不好（问句率与 K=4 相同）。收益（省钱）不抵质量回退，暂不启用。
 */
const DEFAULTS: PersonaFlags = {
  dynamicState: true,
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
