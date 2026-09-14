/**
 * DS娘 v0.4 · 首次启动自举（一次性）
 *
 * 三件事，全部幂等且只做一次（用 localStorage 标记，之后你在设置里怎么改都不会被覆盖）：
 *   1) LLM 供应商：没有任何供应商时写入 DeepSeek（deepseek-flash）并指定为对话模型
 *   2) 工具分组：打开 日程/待办(schedule) + 记忆(memory) + 时钟(clock)
 *      —— LingChat 的分组开关「缺省关闭」（tools/settings.rs:193），不开她就不会真的调用工具
 *   3) 联网搜索：打开 web_search，provider=deepseek、模型 deepseek-v4-pro、填入同一个 Key
 *      （搜索必须用 pro：flash 系不会触发服务端 web_search，见 DS_SEARCH_MODEL 注释）
 *   4) 搜索模型一次性纠偏：老设备已自举过（TOOL_FLAG=1）且搜索模型是 flash 系时改成 pro
 *
 * 设计要点：全部包在 try/catch 里，失败只打日志，绝不影响启动；已有配置绝不覆盖。
 */
import {
  listLlmProviders,
  saveLlmProvider,
  setLlmRole,
  switchLlm,
  type LlmProviderConfig,
} from "@/api/services/llm-providers";
import { getToolSettings, saveToolSettings } from "@/api/services/tool-settings";

/**
 * DeepSeek Key：**不写死在源码里**（构建仓库是公开仓库，硬编码会被 Key 扫描机器人抓走盗刷）。
 * 由 CI 在构建期通过 `VITE_DS_KEY` 注入（见 .github/workflows/build-ios.yml），
 * Vite 会自动把 VITE_* 前缀的环境变量暴露为 import.meta.env.VITE_DS_KEY。
 * 若未注入（例如本地构建），则跳过自举，仍可在「设置 → 高级 → 大模型管理」手动填写。
 */
const ENV = (import.meta as unknown as { env?: Record<string, string> }).env || {};
const DS_KEY = String(ENV.VITE_DS_KEY || "").trim();
/** 官方当前正式模型名（deepseek-v4.1-flash / deepseek-v41-flash 均返回 400，已实测） */
const DS_MODEL = "deepseek-flash";

/**
 * 联网搜索模型：**必须是 pro**，不能用对话用的 flash。
 *
 * 实测（探针脚本 `鲸鱼娘iOS/_diag/deepseek-search-probe.cjs`，同一个 Key、同一个
 * `POST /responses` + `tools:[{type:"web_search"}]` 请求体）：
 *   - `deepseek-v4-pro`      → `web_search_call=8`、`input_tokens≈4.7万~5.9万`（真读了网页）、
 *                              回答里带真实来源链接 ✓
 *   - `deepseek-flash`       → HTTP 200 但 `web_search_call=0`、`input_tokens=61`（一个网页都没读），
 *      `deepseek-v4-flash`      模型把"我要搜索"写成一段 ```json {"query": …}``` 文本，或直接凭
 *      （tool_choice 传 required / {type:web_search} 都一样）
 *
 * 于是旧配置下工具会**假成功**：`result_count`（= web_search_call 条数）恒为 0，
 * 设置页测试显示"成功 · 0 条"，对话里模型拿到那坨 json 文本只好回答"没搜到任何结果"。
 */
const DS_SEARCH_MODEL = "deepseek-v4-pro";

/** flash 系模型名（含空值，空值会让 Rust 回落到同样不能搜索的 deepseek-v4-flash） */
const FLASH_FAMILY_MODELS = [
  "",
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "deepseek-v41-flash",
];

const DS_PROVIDER: LlmProviderConfig = {
  id: DS_MODEL,
  label: "DeepSeek Flash",
  provider: "openai",
  model: DS_MODEL,
  api_key: DS_KEY,
  base_url: "https://api.deepseek.com",
  temperature: null,
  top_p: null,
  enable_thinking: false,
  reasoning_effort: null,
  fast_mode: false,
};

/** 默认打开的工具分组（组名见 tools/settings.rs 的 TOOL_GROUPS） */
const ENABLE_GROUPS = ["schedule", "memory", "clock"];
const TOOL_FLAG = "ds_tools_bootstrap_done";
/** 搜索模型纠偏哨兵（见 fixSearchModelOnce；与 TOOL_FLAG 分开，老设备才会被执行到） */
const SEARCH_MODEL_FIX_FLAG = "ds_search_model_fix_v1";

async function bootstrapLlm(): Promise<void> {
  if (!DS_KEY) {
    console.warn("[DS娘] 未注入 DeepSeek Key（VITE_DS_KEY 为空），跳过 LLM 自举；可在设置里手动配置");
    return;
  }
  const data = await listLlmProviders();
  if (data.providers && data.providers.length > 0) {
    // 已有配置：只在"没有指定对话模型"时补一个，不动用户已有内容
    if (!data.chat_provider_id) {
      await setLlmRole("chat", data.providers[0].id);
      await switchLlm();
    }
    return;
  }
  await saveLlmProvider(DS_PROVIDER);
  await setLlmRole("chat", DS_PROVIDER.id);
  await switchLlm();
  console.log("[DS娘] 已自举 DeepSeek 供应商:", DS_MODEL);
}

export async function bootstrapTools(): Promise<void> {
  if (localStorage.getItem(TOOL_FLAG) === "1") return;
  const s = await getToolSettings();
  const groups = { ...(s.groups || {}) };
  for (const g of ENABLE_GROUPS) groups[g] = true;

  // 联网搜索需要 Key：未注入时只开分组，搜索留给用户在设置里填
  const ws = { ...s.web_search };
  if (DS_KEY) {
    ws.enabled = true;
    ws.provider = "deepseek";
    ws.model = DS_SEARCH_MODEL;
    ws.api_key = DS_KEY;
    ws.proxy_enabled = false;
  }

  await saveToolSettings({ ...s, groups, web_search: ws });
  localStorage.setItem(TOOL_FLAG, "1");
  console.log("[DS娘] 已自举工具分组:", ENABLE_GROUPS.join(", "), DS_KEY ? "+ 联网搜索" : "(搜索未配置 Key，跳过)");
}

/**
 * 一次性纠偏：把已自举设备上的"flash 系搜索模型"改成 pro。
 *
 * 为什么单独一步：`bootstrapTools` 有 `TOOL_FLAG` 哨兵，装过旧版的设备直接 return，
 * 改不到搜索模型；而旧版写进去的正是不能联网的 flash。这里只纠正
 * "provider=deepseek 且模型属于 flash 系（含空值）"这一种组合——
 * 其它 provider、其它模型（例如别人手填的 kimi/tavily/deepseek-reasoner）一律不动。
 */
async function fixSearchModelOnce(): Promise<void> {
  if (localStorage.getItem(SEARCH_MODEL_FIX_FLAG) === "1") return;
  try {
    const s = await getToolSettings();
    const ws = { ...s.web_search };
    if (ws.provider === "deepseek" && FLASH_FAMILY_MODELS.includes(String(ws.model || "").trim())) {
      const from = String(ws.model || "").trim() || "(空 → Rust 默认 deepseek-v4-flash)";
      ws.model = DS_SEARCH_MODEL;
      await saveToolSettings({ ...s, web_search: ws });
      console.log(`[DS娘] 已把联网搜索模型从 ${from} 纠正为 ${DS_SEARCH_MODEL}（flash 系不会真正联网）`);
    }
    localStorage.setItem(SEARCH_MODEL_FIX_FLAG, "1");
  } catch (e) {
    // 失败就不写标记，下次启动重试；不影响启动
    console.warn("[DS娘] 联网搜索模型纠偏失败（可在设置里手动改为 deepseek-v4-pro）:", e);
  }
}

export async function bootstrapDeepSeek(): Promise<void> {
  try {
    await bootstrapLlm();
  } catch (e) {
    console.warn("[DS娘] 自举 LLM 供应商失败（可手动在设置中配置）:", e);
  }
  try {
    await bootstrapTools();
  } catch (e) {
    console.warn("[DS娘] 自举工具设置失败（可手动在设置中配置）:", e);
  }
  try {
    await fixSearchModelOnce();
  } catch (e) {
    console.warn("[DS娘] 联网搜索模型纠偏失败（可手动在设置中配置）:", e);
  }
}
