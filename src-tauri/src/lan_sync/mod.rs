//! 局域网数据同步模块。
//!
//! 通过 mDNS + UDP 发现局域网内的其他 LingChat 设备，
//! 使用 HTTP 协议实现手动 Push/Pull 数据同步。
//!
//! 同步范围：`data/` 下除 `third_party/` 外的所有文件。
//!
//! 前端通过以下 Tauri 命令使用此模块：
//! - `lan_sync_start_server`: 启动本地 HTTP 服务
//! - `lan_sync_stop_server`: 停止本地 HTTP 服务
//! - `lan_sync_scan_peers`: 扫描局域网设备
//! - `lan_sync_plan_push`: 生成推送计划
//! - `lan_sync_execute_push`: 执行推送
//! - `lan_sync_plan_pull`: 生成拉取计划
//! - `lan_sync_execute_pull`: 执行拉取

pub mod client;
pub mod db_sync;
pub mod discovery;
pub mod manifest;
pub mod messages;
pub mod server;
pub mod staging;
pub mod sync_engine;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use tauri::{AppHandle, Emitter, State};
use tracing::{info, warn};
use uuid::Uuid;

use crate::api::data_dir;

use self::messages::{DeviceIdentity, PeerInfo, SyncPlan, SyncResult};

// ─── 全局状态 ────────────────────────────────────────────────

/// LAN 同步全局状态。
pub struct LanSyncState {
    /// HTTP 服务是否运行中
    pub server_running: Mutex<bool>,
    /// 当前保存的同步计划
    pub current_plan: Mutex<Option<SyncPlan>>,
    /// 设备身份（延迟加载）
    pub device_identity: Mutex<Option<DeviceIdentity>>,
    /// 本次会话标识（每次启动服务重新生成）
    pub instance_id: Mutex<Option<String>>,
    /// 配对 token（公网隧道模式；设置后 HTTP 服务要求 `X-LingChat-Token` 头）
    pub server_token: Mutex<Option<String>>,
    /// 本次服务监听端口（诊断用）
    pub server_port: Mutex<Option<u16>>,
    /// mDNS + UDP 宣告句柄
    pub announcer: Mutex<Option<discovery::Announcer>>,
    /// 已发现的对等设备列表
    pub peers: Mutex<Vec<PeerInfo>>,
    /// 取消标志 — 在文件间隙检查，用户可中断同步
    pub cancel_flag: AtomicBool,
}

impl Default for LanSyncState {
    fn default() -> Self {
        Self {
            server_running: Mutex::new(false),
            current_plan: Mutex::new(None),
            device_identity: Mutex::new(None),
            instance_id: Mutex::new(None),
            server_token: Mutex::new(None),
            server_port: Mutex::new(None),
            announcer: Mutex::new(None),
            peers: Mutex::new(Vec::new()),
            cancel_flag: AtomicBool::new(false),
        }
    }
}

/// 获取当前实例标识（只读）。
fn get_instance_id(state: &LanSyncState) -> String {
    state
        .instance_id
        .lock()
        .unwrap()
        .clone()
        .expect("instance_id 应在服务启动时已设置")
}

/// 生成新的实例标识（每次启动服务时调用）。
fn generate_instance_id(state: &LanSyncState) -> String {
    let id = Uuid::new_v4().to_string();
    let mut guard = state.instance_id.lock().unwrap();
    *guard = Some(id.clone());
    id
}

// ─── 设备身份 ────────────────────────────────────────────────

/// 设备身份文件路径。
fn device_identity_path() -> PathBuf {
    data_dir().join(".lan_sync_device.json")
}

/// 获取或创建设备身份。
///
/// 首次调用时如果磁盘上不存在身份文件，则自动生成新的 UUID 和 hostname。
fn get_device_identity(state: &LanSyncState) -> Result<DeviceIdentity, String> {
    {
        let guard = state
            .device_identity
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        if let Some(ref id) = *guard {
            return Ok(id.clone());
        }
    }

    // 尝试从磁盘加载
    let path = device_identity_path();
    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<DeviceIdentity>(&content) {
                Ok(mut id) => {
                    // 旧版本在 iOS 上生成的是 "Unknown Device"，用平台名兜底刷新并回写
                    if id.device_name == "Unknown Device" {
                        id.device_name = get_hostname();
                        if let Ok(json) = serde_json::to_string_pretty(&id) {
                            let _ = fs::write(&path, json);
                        }
                    }
                    let mut guard = state
                        .device_identity
                        .lock()
                        .map_err(|e| format!("锁失败: {e}"))?;
                    *guard = Some(id.clone());
                    return Ok(id);
                },
                Err(e) => warn!("设备身份文件损坏，将重新生成: {e}"),
            },
            Err(e) => warn!("无法读取设备身份文件，将重新生成: {e}"),
        }
    }

    // 生成新身份
    let device_name = get_hostname();

    let identity = DeviceIdentity {
        device_id: Uuid::new_v4().to_string(),
        device_name,
    };

    // 持久化
    let json = serde_json::to_string_pretty(&identity).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入设备身份文件失败: {e}"))?;

    let mut guard = state
        .device_identity
        .lock()
        .map_err(|e| format!("锁失败: {e}"))?;
    *guard = Some(identity.clone());

    info!(
        "已生成设备身份: id={}, name={}",
        identity.device_id, identity.device_name
    );
    Ok(identity)
}

/// 获取 hostname（用于设备名）。
fn get_hostname() -> String {
    // 优先使用环境变量
    #[cfg(target_os = "windows")]
    {
        if let Ok(name) = std::env::var("COMPUTERNAME") {
            if !name.is_empty() {
                return name;
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(name) = std::env::var("HOSTNAME") {
            if !name.is_empty() {
                return name;
            }
        }
    }
    // 移动端没有 HOSTNAME/COMPUTERNAME 环境变量，用平台名兜底，
    // 避免电脑端把手机显示成 "Unknown Device"。
    #[cfg(target_os = "ios")]
    {
        return "iPhone".to_string();
    }
    #[cfg(target_os = "android")]
    {
        return "Android 设备".to_string();
    }
    // 回退
    "Unknown Device".to_string()
}

// ─── Tauri 命令 ──────────────────────────────────────────────

/// 启动本地 HTTP 同步服务。
///
/// 在随机可用端口绑定 axum 服务（0.0.0.0:0），注册 mDNS 宣告 + UDP 监听。
/// 返回实际绑定的端口号。
#[tauri::command]
pub async fn lan_sync_start_server(
    app: AppHandle,
    state: State<'_, LanSyncState>,
) -> Result<u16, String> {
    start_server_inner(app, &state, None).await
}

/// 以配对 token 启动同步服务（公网隧道模式）。token 为空等价于局域网模式。
#[tauri::command]
pub async fn lan_sync_start_server_with_token(
    app: AppHandle,
    state: State<'_, LanSyncState>,
    token: String,
) -> Result<u16, String> {
    let token = {
        let t = token.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    };
    start_server_inner(app, &state, token).await
}

async fn start_server_inner(
    app: AppHandle,
    state: &State<'_, LanSyncState>,
    token: Option<String>,
) -> Result<u16, String> {
    // 并发检查
    {
        let mut running = state
            .server_running
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        if *running {
            return Err("同步服务已在运行中".to_string());
        }
        *running = true;
    }

    let identity = get_device_identity(state)?;
    let instance_id = generate_instance_id(state);

    let token_has = token.is_some();
    {
        let mut guard = state
            .server_token
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        *guard = token.clone();
    }

    // 诊断日志：本机候选 IP
    let all_ips = discovery::get_local_ips().unwrap_or_else(|e| vec![format!("<error: {e}>")]);
    info!("LAN 同步本机候选 IP: {:?}", all_ips);

    // 启动 HTTP 服务（携带 token）
    let port = server::start_server(app.clone(), &identity, token).await?;
    {
        let mut guard = state
            .server_port
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        *guard = Some(port);
    }

    // 启动 mDNS 宣告 + UDP 监听
    let announcer = discovery::Announcer::start(&identity, &instance_id, port).await?;
    {
        let mut guard = state.announcer.lock().map_err(|e| format!("锁失败: {e}"))?;
        *guard = Some(announcer);
    }

    info!(
        "LAN 同步服务已启动，端口: {}, 实例: {}, token={}",
        port,
        &instance_id[..8],
        token_has
    );
    Ok(port)
}

/// 停止本地 HTTP 同步服务。
#[tauri::command]
pub async fn lan_sync_stop_server(state: State<'_, LanSyncState>) -> Result<(), String> {
    {
        let running = state
            .server_running
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        if !*running {
            return Err("同步服务未运行".to_string());
        }
    } // MutexGuard 在此 drop，释放锁

    // 先停止宣告（mDNS + UDP）
    {
        let mut guard = state.announcer.lock().map_err(|e| format!("锁失败: {e}"))?;
        if let Some(a) = guard.take() {
            a.stop();
        }
    }

    server::stop_server().await?;

    {
        let mut running = state
            .server_running
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        *running = false;
    }

    info!("LAN 同步服务已停止");
    Ok(())
}

/// 手动添加对等设备（公网隧道 / 手动地址）。
/// 返回构造好的 PeerInfo，前端随后可用其做 plan_pull / plan_push。
#[tauri::command]
pub async fn lan_sync_add_manual_peer(
    _app: AppHandle,
    _state: State<'_, LanSyncState>,
    url: String,
    token: String,
) -> Result<PeerInfo, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("地址不能为空".to_string());
    }
    let base = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    };
    let rest = base
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && !h.contains('/') && p.chars().all(|c| c.is_ascii_digit()) => {
            (h.to_string(), p.parse::<u16>().map_err(|e| format!("端口无效: {e}"))?)
        },
        _ => {
            let default = if base.starts_with("https://") { 443u16 } else { 80u16 };
            (rest.to_string(), default)
        },
    };
    let token = {
        let t = token.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    };
    let peer = PeerInfo {
        device_id: format!("manual-{}", base),
        instance_id: "manual".to_string(),
        device_name: host.clone(),
        host,
        port,
        data_version: 0,
        file_count: 0,
        base_url: Some(base),
        token,
    };
    info!(
        "手动添加同步设备: {}",
        peer.base_url.as_deref().unwrap_or_default()
    );
    Ok(peer)
}

/// 返回同步诊断信息（本机 IP、服务状态、端口、已发现设备）。
#[tauri::command]
pub async fn lan_sync_debug_info(state: State<'_, LanSyncState>) -> Result<serde_json::Value, String> {
    let ips = discovery::get_local_ips().unwrap_or_else(|e| vec![format!("<error: {e}>")]);
    let running = *state
        .server_running
        .lock()
        .map_err(|e| format!("锁失败: {e}"))?;
    let port = state
        .server_port
        .lock()
        .map_err(|e| format!("锁失败: {e}"))?
        .clone();
    let instance_id = state
        .instance_id
        .lock()
        .map_err(|e| format!("锁失败: {e}"))?
        .clone();
    let peers = state
        .peers
        .lock()
        .map_err(|e| format!("锁失败: {e}"))?
        .clone();
    let has_token = state
        .server_token
        .lock()
        .map_err(|e| format!("锁失败: {e}"))?
        .is_some();
    Ok(serde_json::json!({
        "localIps": ips,
        "serverRunning": running,
        "serverPort": port,
        "hasToken": has_token,
        "instanceId": instance_id,
        "peers": peers,
    }))
}

/// 扫描局域网中的其他 LingChat 设备。
///
/// 并行运行 mDNS 浏览 + UDP 广播探测。
/// 复用 `Announcer` 持有的 daemon，不创建新的。
/// 结果通过 `lan-sync-peers-updated` 事件推送到前端，同时直接返回。
#[tauri::command]
pub async fn lan_sync_scan_peers(
    app: AppHandle,
    state: State<'_, LanSyncState>,
) -> Result<Vec<PeerInfo>, String> {
    let instance_id = get_instance_id(&state);

    // 从 Announcer 获取共享的 daemon（clone 后释放锁）
    let daemon = {
        let guard = state.announcer.lock().map_err(|e| format!("锁失败: {e}"))?;
        guard
            .as_ref()
            .ok_or("同步服务未启动，请先打开同步面板")?
            .daemon
            .clone()
    };

    let peers = discovery::discover_peers(&app, &daemon, &instance_id).await?;

    // 更新缓存
    {
        let mut cache = state.peers.lock().map_err(|e| format!("锁失败: {e}"))?;
        *cache = peers.clone();
    }

    // 推送到前端
    let _ = app.emit("lan-sync-peers-updated", &peers);

    info!("发现 {} 个局域网设备", peers.len());
    Ok(peers)
}

/// 生成推送计划（本地 → 对端）。
///
/// 计划通过 `lan-sync-plan` 事件发送到前端供用户确认。
#[tauri::command]
pub async fn lan_sync_plan_push(
    app: AppHandle,
    state: State<'_, LanSyncState>,
    peer: PeerInfo,
) -> Result<(), String> {
    let identity = get_device_identity(&state)?;
    let plan = sync_engine::plan_push(&identity, &peer).await?;

    let _ = app.emit("lan-sync-plan", &plan);

    let mut guard = state
        .current_plan
        .lock()
        .map_err(|e| format!("锁失败: {e}"))?;
    *guard = Some(plan);

    Ok(())
}

/// 生成拉取计划（对端 → 本地）。
///
/// 计划通过 `lan-sync-plan` 事件发送到前端供用户确认。
#[tauri::command]
pub async fn lan_sync_plan_pull(
    app: AppHandle,
    state: State<'_, LanSyncState>,
    peer: PeerInfo,
) -> Result<(), String> {
    let identity = get_device_identity(&state)?;
    let plan = sync_engine::plan_pull(&identity, &peer).await?;

    let _ = app.emit("lan-sync-plan", &plan);

    let mut guard = state
        .current_plan
        .lock()
        .map_err(|e| format!("锁失败: {e}"))?;
    *guard = Some(plan);

    Ok(())
}

/// 执行已计划的推送操作。
///
/// 传输过程中通过 `lan-sync-progress` 事件报告进度，
/// 完成后通过 `lan-sync-complete` 发送结果。
#[tauri::command]
pub async fn lan_sync_execute_push(
    app: AppHandle,
    state: State<'_, LanSyncState>,
) -> Result<SyncResult, String> {
    let plan = {
        let guard = state
            .current_plan
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        guard
            .clone()
            .ok_or_else(|| "没有待执行的同步计划".to_string())?
    };

    // 重置取消标志
    state
        .cancel_flag
        .store(false, std::sync::atomic::Ordering::SeqCst);

    let result = sync_engine::execute_push(&plan, &app, &state.cancel_flag).await;

    // 发送完成事件
    match &result {
        Ok(r) => {
            let _ = app.emit("lan-sync-complete", r);
        },
        Err(e) => {
            let _ = app.emit(
                "lan-sync-complete",
                &SyncResult {
                    success: false,
                    direction: "push".to_string(),
                    files_downloaded: 0,
                    files_deleted: 0,
                    files_staged: 0,
                    bytes_transferred: 0,
                    message: e.clone(),
                },
            );
        },
    }

    // 清空计划
    {
        let mut guard = state
            .current_plan
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        *guard = None;
    }

    result
}

/// 执行已计划的拉取操作。
///
/// 传输过程中通过 `lan-sync-progress` 事件报告进度，
/// 完成后通过 `lan-sync-complete` 发送结果。
#[tauri::command]
pub async fn lan_sync_execute_pull(
    app: AppHandle,
    state: State<'_, LanSyncState>,
) -> Result<SyncResult, String> {
    let plan = {
        let guard = state
            .current_plan
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        guard
            .clone()
            .ok_or_else(|| "没有待执行的同步计划".to_string())?
    };

    // 重置取消标志
    state
        .cancel_flag
        .store(false, std::sync::atomic::Ordering::SeqCst);

    let result = sync_engine::execute_pull(&plan, &app, &state.cancel_flag).await;

    // 发送完成事件
    match &result {
        Ok(r) => {
            let _ = app.emit("lan-sync-complete", r);
        },
        Err(e) => {
            let _ = app.emit(
                "lan-sync-complete",
                &SyncResult {
                    success: false,
                    direction: "pull".to_string(),
                    files_downloaded: 0,
                    files_deleted: 0,
                    files_staged: 0,
                    bytes_transferred: 0,
                    message: e.clone(),
                },
            );
        },
    }

    // 清空计划
    {
        let mut guard = state
            .current_plan
            .lock()
            .map_err(|e| format!("锁失败: {e}"))?;
        *guard = None;
    }

    result
}

// ─── 重启 ─────────────────────────────────────────────────────

/// 重启应用以应用暂存的同步文件（桌面端，依赖 tauri-plugin-process）。
#[cfg(desktop)]
#[tauri::command]
pub fn lan_sync_restart(app: tauri::AppHandle) -> Result<(), String> {
    app.restart();
}

/// 重启应用（移动端暂不支持，返回提示）。
#[cfg(not(desktop))]
#[tauri::command]
pub fn lan_sync_restart() -> Result<(), String> {
    Err("重启功能仅在桌面端可用".to_string())
}
