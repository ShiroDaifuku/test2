//! DS娘 v0.4 · 「静默云同步」用的手动笔记读写命令 + MemoryBank 段落导入命令。
//!
//! 前端通过这里的三条命令操作**当前角色**，不接触任何 DB 结构：
//! - `ds_get_notes`：读出该角色笔记数组（文件不存在 ⇒ 空数组 `[]`，不算失败）
//! - `ds_set_notes`：把整个数组合并结果覆盖写回该文件（目录不存在则创建）
//! - `ds_import_memory_sections`：把云端「旧版记忆」一次性并入 MemoryBank 的
//!   `user_info` / `long_term` / `promises` / `short_term` 段落，使其在**每一轮
//!   对话里自动注入**（注入点见 `ai_service/game_system/role_manager.rs:620-672`
//!   的 `merge_memory_bank_into_context`，由 `sync_memories` 调用）。
//!
//! 实现全部复用既有代码，不新增存储层：
//! - 文件路径 / 解析 / 原子写：`ai_service::tools::memory`
//!   （`data/game_data/notes/<sanitize(角色名)>.json`，见
//!   `src-tauri/src/ai_service/tools/memory.rs:33-77`）
//! - 取当前角色名：与 `api/chat.rs` 的 `feed_text` 完全同一写法
//!   （`src-tauri/src/api/chat.rs:592-599`）：
//!   `state.ai_service.lock()` → `svc.game_status.lock()` →
//!   `current_role_id` → `role_manager.get_loaded(id).display_name`
//! - 共享 `GameStatus` 句柄 / 锁顺序：`ai_service::tools::game_status_handle`
//!   （`src-tauri/src/ai_service/tools/mod.rs:48-56`，其文档明确要求
//!   `ai_service.lock()` → `game_status.lock()` 的顺序，禁止反向嵌套）
//! - MemoryBank 结构 / 段长上限 / DB 读写：`ai_service::types`（`:233-296`）、
//!   `persistent_memory_system`（`:89-116`）、`role_manager`（`:585-612`）

use std::collections::HashSet;

use serde_json::{json, Value};

// 复用既有工具模块的笔记 I/O：可见性在 `ai_service/tools/memory.rs` 内改为
// `pub(crate)`，行为未改动。这里只做命令层的类型转换。
use crate::ai_service::tools::game_status_handle;
use crate::ai_service::tools::memory::{load_role_notes, save_role_notes};
// 段长上限截断规则与压缩/注入侧**完全同一份实现**（只为可见性从私有改为
// `pub(crate)`，行为未改动），避免这里自造一套截断规则导致两侧不一致。
use crate::ai_service::game_system::persistent_memory_system::truncate_to_chars;

/// 取「当前对话角色」的权威展示名（`display_name`）。
///
/// 依据 `api/chat.rs:592-599`（`feed_text`）的同款写法，也等价于
/// `ai_service/tools/memory.rs:80-94` 的 `current_display_name`。
/// 不查询 DB、不访问网络，只读内存中的 `GameStatus` 快照。
///
/// 拿不到名字时返回明确错误：前端会把 notes 这一段跳过，其余（待办/日志）照常同步。
async fn current_role_display_name(app: &tauri::AppHandle) -> Result<String, String> {
    let gs = game_status_handle(app).await;
    let gs = gs.lock().await;
    if gs.current_role_id.is_none() {
        return Err("当前没有选中对话角色，无法定位手动笔记文件".to_string());
    }
    let name = gs
        .current_role_id
        .and_then(|id| gs.role_manager.get_loaded(id))
        .and_then(|role| role.display_name.clone())
        .filter(|name| !name.trim().is_empty());
    match name {
        Some(name) => Ok(name),
        None => Err("当前角色尚未加载完成（没有展示名），无法定位手动笔记文件".to_string()),
    }
}

/// 读取**当前角色**的手动笔记。
///
/// 返回原始 JSON 数组，元素形如 `{id, content, tags:[], created_at}`
/// （即 `memory::Note` 的序列化结果）。文件不存在时返回 `[]` 而不报错，
/// 与 `memory_get_notes` 工具（`ai_service/tools/memory.rs:235-255`）保持一致。
#[tauri::command]
pub async fn ds_get_notes(app: tauri::AppHandle) -> Result<Value, String> {
    let display_name = current_role_display_name(&app).await?;
    let notes = load_role_notes(&display_name)?;
    serde_json::to_value(notes).map_err(|e| format!("序列化笔记失败: {e}"))
}

/// 覆盖写**当前角色**的手动笔记（前端已按 id 合并云端结果后整体回传）。
///
/// 参数 `notes` 直接收 JSON：前端传数组即可（`invoke("ds_set_notes", { notes })`）。
/// 内部复用 `memory::save_role_notes` 的 `.tmp + rename` 原子替换
/// （`ai_service/tools/memory.rs:69-77`），目录不存在会自动创建。
#[tauri::command]
pub async fn ds_set_notes(app: tauri::AppHandle, notes: Value) -> Result<(), String> {
    if !notes.is_array() {
        return Err("ds_set_notes 的 notes 必须是 JSON 数组".to_string());
    }
    let display_name = current_role_display_name(&app).await?;
    // 走 Note 结构体再落盘：既能过滤掉结构不对的元素，也保证写入格式与工具侧一致。
    let parsed: Vec<crate::ai_service::tools::memory::Note> = serde_json::from_value(notes)
        .map_err(|e| format!("笔记格式不正确（应为 {{id, content, tags, created_at}} 数组）: {e}"))?;
    save_role_notes(&display_name, &parsed)
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryBank 段落导入（DS娘 v0.4 · 旧版记忆一次性并入）
// ─────────────────────────────────────────────────────────────────────────────

/// 把一段导入文本并入既有段落正文。
///
/// 规则（与需求一致）：
/// 1. **追加合并**，绝不整段覆盖：既有正文在前，新导入的行按原顺序接在后面；
/// 2. **按行去重**：以「去除首尾空白后的整行文本」为键，忽略空白差异（CRLF / 空格 / 制表符），
///    因此重复导入同一批内容不会堆积；只被去重跳过、没有真正新增内容时，直接返回原值；
/// 3. **尊重段长上限**：去重后的合并结果按 `truncate_to_chars`（同一份实现）截断，
///    截断时**保留新并入的内容**（先塞新行，再从后往前补旧行），避免上限较小时
///    这次导入被整段丢掉。上限为 0 表示不截断。
fn merge_section_text(existing: &str, incoming: &str, max_chars: usize) -> String {
    let incoming_lines: Vec<String> = incoming
        .split('\n')
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    if incoming_lines.is_empty() {
        return existing.to_string();
    }

    // 既有正文里的所有行（含空行，保持原文可读性）；键集合用于去重。
    let mut seen: HashSet<String> = HashSet::new();
    let existing_lines: Vec<String> = existing
        .split('\n')
        .map(|line| line.to_string())
        .collect();
    for line in &existing_lines {
        seen.insert(line.trim().to_string());
    }
    let existing_has_content = existing_lines.iter().any(|line| !line.trim().is_empty());

    let new_lines: Vec<String> = incoming_lines
        .into_iter()
        .filter(|line| seen.insert(line.clone()))
        .collect();
    if new_lines.is_empty() {
        // 全部命中既有内容：不写回、不改动，天然幂等。
        return existing.to_string();
    }

    let mut combined: Vec<String> = Vec::new();
    if existing_has_content {
        combined.push(existing.trim_end().to_string());
    }
    combined.push(new_lines.join("\n"));
    let combined = combined.join("\n");

    if max_chars == 0 || combined.chars().count() <= max_chars {
        return combined;
    }

    // 超限：优先保住新并入的行，再用旧行把剩余预算填满（旧内容按从后往前的顺序补，
    // 与既有压缩流程「超限尾部被丢弃」的方向一致）。
    let budget = max_chars;
    let new_set: HashSet<&str> = new_lines.iter().map(|line| line.as_str()).collect();
    let mut kept: Vec<String> = Vec::new();
    let mut used = 0usize;
    for line in new_lines.iter().rev() {
        let cost = line.chars().count();
        if used + cost > budget {
            continue;
        }
        used += cost;
        kept.push(line.clone());
    }
    for line in existing_lines.iter().rev() {
        let line = line.trim();
        // 空行只是排版，不占预算；与新并入内容重复的旧行也不再重复计入。
        if line.is_empty() || new_set.contains(line) {
            continue;
        }
        let cost = line.chars().count();
        if used + cost > budget {
            continue;
        }
        used += cost;
        kept.push(line.to_string());
    }
    kept.reverse();
    truncate_to_chars(&kept.join("\n"), max_chars)
}

/// 与 `persistent_memory_system.rs:689-691` 的 `now_str()` 完全同格式，
/// 保证 `meta.updated_at` 在 DB / 界面里看起来一致。
fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 把云端「旧版记忆」一次性并入**当前角色**的 MemoryBank 段落。
///
/// 参数 `sections` 形如 `{ "user_info": "…", "long_term": "…", "promises": "…", "short_term": "…" }`，
/// 键都可以缺失（缺失 / 非字符串 / 空白 = 该段不动），值为要**并入**正文的文本。
///
/// 行为：
/// 1. 取「当前角色」= `gs.current_role_id`（`game_status.rs:25`；与
///    `current_role_display_name` 用同一个字段），拿不到就明确报错（前端跳过导入）；
/// 2. 逐段调用 `merge_section_text`：追加 + 按行去重，并按该角色的**既有**
///    段长上限（`PersistentMemorySystem.section_limits`，`persistent_memory_system.rs:89-105`，
///    来源 `GameRoleManager.memory_limits`，`role_manager.rs:42-43`）截断；
/// 3. 写回 `GameRole.memory_bank`（`types.rs:566-578`）**和**运行时压缩系统的
///    `memory_bank`（`persistent_memory_system.rs:144`）—— 只改一处会被
///    `sync_to_role`（`:338-347`）覆盖回旧内容，这是「改完必须立刻生效」的关键；
///    `meta.updated_at` 同步刷新（`types.rs:234-239`）；
/// 4. 走既有 `GameRoleManager::persist_memory_banks_to_db`（`role_manager.rs:585-612`）
///    落盘，保留其内部 `sync_to_role` → `MemoryRepo::upsert_memory` 的顺序与并发语义，
///    不绕过 `has_pending` / `commit_gate` / `history_revision` 任何既有保护，
///    也不触碰 `last_processed_global_idx`（压缩指针），不会引发重复压缩或丢摘要。
///
/// 返回可核对信息：`{ ok, role_id, merged: {段名: 合并后字符数}, updated_at }`。
/// `merged` 里的长度都在段长上限之内（超限部分已被既有规则截断）。
#[tauri::command]
pub async fn ds_import_memory_sections(
    app: tauri::AppHandle,
    sections: Value,
) -> Result<Value, String> {
    let Some(obj) = sections.as_object() else {
        return Err("ds_import_memory_sections 的 sections 必须是 JSON object".to_string());
    };
    // 只认这 4 个既有段落名（`types.rs:241-247`），其余键忽略。
    const SECTION_KEYS: [&str; 4] = ["user_info", "long_term", "promises", "short_term"];
    let incoming: Vec<(&str, String)> = SECTION_KEYS
        .iter()
        .filter_map(|key| {
            let text = obj
                .get(*key)
                .and_then(|value| value.as_str())
                .map(|text| text.trim().to_string())?;
            if text.is_empty() {
                None
            } else {
                Some((*key, text))
            }
        })
        .collect();
    if incoming.is_empty() {
        return Err("ds_import_memory_sections 的 sections 里没有任何非空段落".to_string());
    }

    let gs_handle = game_status_handle(&app).await;
    let mut gs = gs_handle.lock().await;

    let role_id = gs
        .current_role_id
        .ok_or_else(|| "当前没有选中对话角色，无法导入记忆段落".to_string())?;
    if gs.role_manager.get_loaded(role_id).is_none() {
        return Err(format!(
            "当前角色（role_id={role_id}）尚未加载完成，无法导入记忆段落"
        ));
    }

    // 该角色的段长上限：压缩系统存在时用它创建时拿到的真实上限（`role_manager.rs:299-317`
    // 传的是 `self.memory_limits`）；系统还没惰性构造时退回默认上限——两者同源，
    // 默认值见 `persistent_memory_system.rs:96-105`。
    let limits = gs
        .role_manager
        .memory_bank_system(role_id)
        .map(|system| system.section_limits)
        .unwrap_or_default();

    let mut merged_lengths: serde_json::Map<String, Value> = serde_json::Map::new();
    for (section, text) in incoming {
        let max_chars = match section {
            "user_info" => limits.user_info,
            "long_term" => limits.long_term,
            "promises" => limits.promises,
            _ => limits.short_term,
        };

        // 借用作用域收窄：先取出旧正文、算出新正文，再写回两份 MemoryBank。
        let (new_text, new_chars) = {
            let role = gs
                .role_manager
                .get_loaded(role_id)
                .ok_or_else(|| format!("角色 {role_id} 未加载"))?;
            let existing = match section {
                "user_info" => role.memory_bank.data.user_info.as_str(),
                "long_term" => role.memory_bank.data.long_term.as_str(),
                "promises" => role.memory_bank.data.promises.as_str(),
                _ => role.memory_bank.data.short_term.as_str(),
            };
            let new_text = merge_section_text(existing, &text, max_chars);
            (new_text, new_text.chars().count())
        };

        {
            let role = gs
                .role_manager
                .get_loaded_mut(role_id)
                .ok_or_else(|| format!("角色 {role_id} 未加载"))?;
            match section {
                "user_info" => role.memory_bank.data.user_info = new_text.clone(),
                "long_term" => role.memory_bank.data.long_term = new_text.clone(),
                "promises" => role.memory_bank.data.promises = new_text.clone(),
                _ => role.memory_bank.data.short_term = new_text.clone(),
            }
            role.memory_bank.meta.updated_at = now_str();
        }

        // 运行时压缩系统的同一段落也要更新：`sync_memories` 每轮对话都会
        // `sync_to_role`，只改 `GameRole` 会被系统里的旧值覆盖回去。
        if let Some(system) = gs.role_manager.memory_bank_system(role_id) {
            let mut bank = system.memory_bank.lock().await;
            match section {
                "user_info" => bank.data.user_info = new_text.clone(),
                "long_term" => bank.data.long_term = new_text.clone(),
                "promises" => bank.data.promises = new_text.clone(),
                _ => bank.data.short_term = new_text.clone(),
            }
            bank.meta.updated_at = now_str();
        }

        merged_lengths.insert(section.to_string(), json!(new_chars));
    }
    // 显式释放 `game_status` 守卫，再重新取一次存档号（锁顺序仍是 `ai_service` ← `game_status`，
    // 不允许在持有 `game_status` 时去等 `ai_service`）。
    drop(gs);

    // 持久化：走既有入口，内部先 `sync_to_role` 再按角色 upsert（`role_manager.rs:575-602`）。
    // `active_save_id` 为空（还没建/载存档）时跳过落盘——与 `create_save`/`update_save`
    // 只在有存档时持久化 MemoryBank 的既有行为一致（`api/save.rs:172-176`、`:311-315`）。
    let active_save_id = gs_handle.lock().await.active_save_id;
    let mut persisted = false;
    if let Some(save_id) = active_save_id {
        // `AppState` 通过 `Deref` 链暴露 `db` / `ai_service`
        // （`api/save.rs:133-134`、`api/role_archive/mod.rs:395` 同款写法）。
        let state = app.state::<crate::AppState>();
        let mut service = state.ai_service.lock().await;
        service
            .game_status
            .lock()
            .await
            .role_manager
            .persist_memory_banks_to_db(&service.db, save_id, Some(&[role_id]))
            .await
            .map_err(|e| format!("持久化记忆库失败: {e}"))?;
        persisted = true;
    }

    Ok(json!({
        "ok": true,
        "role_id": role_id,
        "merged": Value::Object(merged_lengths),
        "updated_at": now_str(),
        "persisted": persisted,
    }))
}
