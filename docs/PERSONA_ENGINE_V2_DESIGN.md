# Persona Engine V2 设计草案

目标：在不破坏 build6 稳定基线的前提下，把“角色是谁、此刻怎样、记得什么、这轮怎么答”拆成可测试、可回滚的独立层。

## 1. 分层边界

| 层 | 职责 | 不负责 |
|---|---|---|
| Identity | 不变身份、关系边界、语言习惯、禁区 | 临时心情和具体事件 |
| State | 心情、精力、信任、亲密、紧张及衰减 | 永久事实 |
| Relationship | 阶段、承诺、边界变化 | 原始对话归档 |
| Memory | 事件、事实、承诺的结构化存储与检索 | 决定回复策略 |
| Example | 按场景检索少量高质量行为示范 | 重复整份示范集 |
| Planner | 生成回复意图、长度、情绪和是否提问 | 直接写最终台词 |
| Critic | 记录漂移分数和原因 | build6 阶段自动多次重生成 |

## 2. 建议数据契约

Episodic Memory 最小字段：`id`、`sourceTurnIds`、`occurredAt`、`participants`、`summary`、`facts`、`emotion`、`importance`、`confidence`、`supersedes`、`createdAt`、`updatedAt`。所有派生记忆必须保留来源 turn ID，允许追溯和删除。

Planner 输出固定 JSON：`intent`、`emotion`、`length`、`askQuestion`、`useMemoryIds`、`toolPlan`、`safetyNotes`。渲染器只接受通过 schema 校验的结果；失败时回退 build6 的直出路径。

## 3. 检索与预算

检索顺序：硬约束与承诺 → 当前话题事件 → 用户稳定信息 → 最近互动。按相关度、重要度、新鲜度和置信度加权；同一来源去重。Prompt 中始终保留 Identity 和必要承诺，只让 Episodic Memory 使用 Top-K。

每层设独立字符/token 预算并记录实际占用。超预算时先删低置信事件，再缩写事件，不能裁掉身份边界或尚未兑现的承诺。

## 4. 迁移顺序

1. 以 build6 为稳定对照组，完成真机基线。
2. 为现有 notes/MemoryBank 增加只读适配器和来源字段；不立即迁移原文件。
3. 上线 Behaviour Example Repository，仅做检索和日志，不改变回复。
4. 上线 Episodic Memory 双写，比较旧/新检索结果，确认后再切读。
5. Planner 先 shadow mode，只记录计划与真实回复差异。
6. Critic 先只评分；与人工盲评建立相关性后，最多允许一次重生成。

## 5. 验收门槛

- 人设约束合规率不低于 build6。
- 末行问句率、建议率、AI 味指标不劣于 build6 的置信区间。
- 50 轮对话后承诺召回、时间一致性和关系状态无明显漂移。
- 任一 V2 层均可单独关闭并立即清除运行时影响。
- 所有记忆可追溯、可导出、可删除；无来源的数据不得提升为高置信长期记忆。

