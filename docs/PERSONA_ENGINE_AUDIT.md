# Persona Engine 现状审计（build6）

审计基线：DS娘 `0.4.0-beta.6`；结论日期：2026-09-22。

## 1. 结论

当前实现已经形成可工作的 Persona v1：角色静态人设、行为示范、动态状态、持久记忆和工具调用能进入同一轮 LLM 请求。动态状态已通过现有 140 轮 A/B 指标，build6 默认开启；检索式记忆虽已完整接线，但会提高末行问句率和 AI 味，继续默认关闭。

build6 不引入 Response Planner、自动重生成或 Critic，以避免在真机基线尚未建立前扩大变量范围。

## 2. 实际消息拼装路径

1. `settings.yml` 提供角色 system prompt、情绪标签约束、示范和长度策略。
2. `RoleManager::sync_memories` 先加载角色并同步 MemoryBank，再按 MemoryBank 的 `slice_start` 裁剪旧台词。
3. 如果裁剪后丢失角色 SYSTEM 行，会从完整历史补回第一条 SYSTEM 行。
4. `MemoryBuilder` 把台词转换成角色上下文；连续末尾 user 行作为 active user 输入，其前内容作为历史上下文。
5. `compose_runtime_addendum` 依次拼接：全量 MemoryBank（仅在未被检索替换时）、当前 Persona 状态、本轮相关记忆。
6. 合并后的 messages 与工具 schema 交给 provider；工具返回再作为后续消息继续同一轮管线。

关键实现：

- `src-tauri/src/ai_service/game_system/role_manager.rs`
- `src-tauri/src/ai_service/game_system/memory_builder.rs`
- `src-tauri/src/api/ds_memory.rs`
- `src-tauri/src/ai_service/message_system/generator.rs`

## 3. 状态与记忆

| 层 | 存储 | 注入方式 | build6 默认 |
|---|---|---|---|
| 静态身份/示范 | 角色 `settings.yml` | SYSTEM | 开 |
| 动态状态 | localStorage `ds_persona_state_v1`；运行时镜像 `persona_state.json` | SYSTEM addendum | 开 |
| MemoryBank | 角色存档中的 user_info / promises / long_term / short_term | SYSTEM + USER 前缀 | 开 |
| Top-K 检索 | 运行时 `memory_recall.json` | 替换全量三段并注入相关条目 | 关 |
| 手动笔记 | 角色 notes JSON，字段为 id/content/tags/created_at | MemoryBank/检索来源 | 开 |
| 待办 | `TodoItem`，含 id/content/completed/deadline/remind_at | 工具与主动系统 | 开 |

MemoryBank 对 user_info、promises、long_term、short_term 均有字符上限；压缩在后台执行，并用历史 revision 防止旧任务覆盖新历史。当前笔记和检索条目没有稳定的来源 turn ID，这是后续结构化 Episodic Memory 的主要缺口。

## 4. Provider 请求与采样参数

`genai_provider.rs` 构建 ChatRequest（model/messages/tools），ChatOptions 负责：

- `temperature`、`top_p`；
- `tool_choice`（auto/none/required）；
- `thinking.type`；非 MiniMax 且开启思考时加入 `thinking.reasoning_effort`；
- 捕获 content、tool calls、reasoning content 和 token usage。

请求日志已把 ChatOptions 中的有效字段合并到日志 JSON，避免日志与真实请求不一致。API Key 不进入仓库；build6 仍通过 GitHub Actions Secret 注入。

## 5. 功能开关与回滚

`src/api/ds-persona-flags.ts` 使用 `ds_persona_flags`：

- `dynamicState=true`
- `memoryRetrieval=false`

build6 在“高级设置 → DS娘 → Persona Engine”提供可见开关和 JSON 导出。关闭某层时会清空对应运行时注入，避免 localStorage 已关闭但 Rust 仍读取旧运行时文件。Git 基线标签为 `baseline/persona-v0.4-pre-build6`。

## 6. 已验证与未验证

已验证：Vue/TypeScript 类型检查、Vite 生产构建、Persona 状态/检索专项测试、版本一致性检查、110 个 LFS 媒体对象恢复。

须由 build6 真机验证：首次启动资源播种、状态跨启动、待办通知、云同步冲突、工具调用闭环、长对话裁剪、断网降级、后台恢复和 iPad 布局。

## 7. 风险清单

- 检索式记忆质量回退：保持默认关闭，只有受控 A/B 测试时开启。
- 前端主包偏大：不阻塞 build6，但应在后续做按需加载。
- build6 为无签名 IPA：安装前需要个人/开发者证书重签。
- 外围旧诊断脚本曾含硬编码 Key：不在主仓库与构建上下文中；旧 Key 仍应在供应商后台轮换。

