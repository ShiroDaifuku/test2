//! DS娘 v0.4 · 「静默云同步」用的手动笔记读写命令。
//!
//! 前端只通过这两条命令读写**当前角色**的手动笔记文件，不接触任何 DB 结构：
//! - `ds_get_notes`：读出该角色笔记数组（文件不存在 ⇒ 空数组 `[]`，不算失败）
//! - `ds_set_notes`：把整个数组合并结果覆盖写回该文件（目录不存在则创建）
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

use serde_json::Value;

// 复用既有工具模块的笔记 I/O：可见性在 `ai_service/tools/memory.rs` 内改为
// `pub(crate)`，行为未改动。这里只做命令层的类型转换。
use crate::ai_service::tools::game_status_handle;
use crate::ai_service::tools::memory::{load_role_notes, save_role_notes};

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
