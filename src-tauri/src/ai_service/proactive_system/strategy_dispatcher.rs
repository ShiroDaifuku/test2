use crate::ai_service::game_system::game_status::GameStatus;
use crate::ai_service::proactive_system::config::ProactiveConfig;
use crate::ai_service::proactive_system::types::{
    IntentType, PerceptionResult, TodoItem, UserScheduleSettings, UserState,
};
use crate::ai_service::screen_analyzer::{ScreenAnalyzer, ScreenAnalyzerConfig};
use chrono::{Local, NaiveDate, NaiveDateTime};
use rand::Rng;
use tokio::sync::Mutex;

pub struct StrategyDispatcher {
    screen_analyzer: Mutex<ScreenAnalyzer>,
}

/// 返回主动提醒可使用的绝对时间说明；None 表示该条已过期或时间语义不可靠，不能主动提起。
fn todo_time_context_at(todo: &TodoItem, now: NaiveDateTime) -> Option<String> {
    let raw = todo.deadline.as_deref().or(todo.remind_at.as_deref());
    if let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) {
        let parsed = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"]
            .iter()
            .find_map(|fmt| NaiveDateTime::parse_from_str(raw, fmt).ok())
            .or_else(|| {
                NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                    .ok()
                    .and_then(|date| date.and_hms_opt(23, 59, 59))
            });
        let at = parsed?; // 有时间字段却无法解析：旧脏数据，不主动误读
        if at <= now {
            return None;
        }
        return Some(format!("绝对时间 {}（尚未到达）", at.format("%Y-%m-%d %H:%M")));
    }

    // 旧数据可能把“明天/下周”只写在正文里。没有记录锚点就无法知道它究竟是哪一天，
    // 宁可不主动提醒，也不能在数周后仍把它解释成新的“明天”。
    const RELATIVE_WORDS: [&str; 12] = [
        "今天", "今晚", "明天", "明晚", "后天", "下周", "周末", "下个月", "月底",
        "过几天", "一会儿", "待会",
    ];
    if RELATIVE_WORDS.iter().any(|word| todo.text.contains(word)) {
        return None;
    }
    Some("未设置具体时间；只能询问是否仍需处理，不得自行推断今天或明天".to_string())
}

impl StrategyDispatcher {
    pub fn new(app_handle: &tauri::AppHandle) -> Self {
        Self {
            screen_analyzer: Mutex::new(ScreenAnalyzer::new(ScreenAnalyzerConfig::resolve(
                app_handle,
            ))),
        }
    }

    /// 更新配置（同时同步 ScreenAnalyzer 的配置，同步执行无需 async）。
    pub fn update_config(&self, app_handle: &tauri::AppHandle) {
        // try_lock: update_config 不涉及 async，用同步锁即可
        if let Ok(mut sa) = self.screen_analyzer.try_lock() {
            sa.update_config(ScreenAnalyzerConfig::resolve(app_handle));
        }
    }

    /// 生成主动对话的 Prompt。
    /// 优先顺序: ImportantDay (每天仅一次) > Todo > Screen Observation > Topic
    pub async fn get_proactive_prompt(
        &self,
        game_status: &GameStatus,
        settings: &UserScheduleSettings,
        perception: &PerceptionResult,
        config: &ProactiveConfig,
    ) -> Option<(String, IntentType)> {
        let now = Local::now();
        let today_str = now.format("%m-%d").to_string();

        // 1. 检查 ImportantDay (如果是今天且今天未触发过)
        if config.enable_important_day_reminder {
            if let Some(important_days) = &settings.important_days {
                let last_talk_date = game_status
                    .last_dialog_time
                    .map(|dt| dt.format("%m-%d").to_string())
                    .unwrap_or_default();

                if last_talk_date != today_str {
                    for day in important_days {
                        if day.date.ends_with(&today_str) {
                            let desc = day.desc.as_deref().unwrap_or("");
                            let char_name = game_status
                                .current_role_id
                                .and_then(|rid| game_status.role_manager.get_loaded(rid))
                                .and_then(|role| role.display_name.clone())
                                .unwrap_or_else(|| "小灵".to_string());

                            tracing::info!(
                                "[StrategyDispatcher] Triggered important day reminder: {}",
                                day.title
                            );
                            return Some((
                                format!(
                                    "{{今天是特殊的一天：{}，{}。可以和{}聊聊哦}}",
                                    day.title, desc, char_name
                                ),
                                IntentType::ImportantDay,
                            ));
                        }
                    }
                }
            }
        }

        // 2. 随机模式选择，根据启用状态动态构建候选列表
        let mut modes = Vec::new();
        let mut weights = Vec::new();

        // 获取权重（如果配置文件有设置，否则基于 UserState 动态决定）
        let mut todo_w = config.todo_weight;
        let mut topic_w = config.topic_weight;
        let mut screen_w = config.screen_weight;

        if todo_w <= 0.0 {
            todo_w = if perception.state == UserState::WORK {
                60.0
            } else {
                10.0
            };
        }
        if topic_w <= 0.0 {
            topic_w = if perception.state == UserState::IDLE {
                80.0
            } else {
                60.0
            };
        }
        if screen_w <= 0.0 {
            screen_w = if perception.state == UserState::GAME {
                60.0
            } else {
                30.0
            };
        }

        if config.enable_todo_perception {
            modes.push("TODO");
            weights.push(todo_w);
        }
        if config.enable_topic_creator {
            modes.push("TOPIC");
            weights.push(topic_w);
        }
        if config.enable_visual_perception {
            modes.push("SCREEN");
            weights.push(screen_w);
        }

        if modes.is_empty() {
            return None;
        }

        // 轮盘赌/加权随机选择
        let selected_mode = {
            let mut rng = rand::thread_rng();
            let total_weight: f64 = weights.iter().sum();
            let mut roll = rng.gen_range(0.0..total_weight);
            let mut selected = modes[0];
            for (i, &w) in weights.iter().enumerate() {
                roll -= w;
                if roll <= 0.0 {
                    selected = modes[i];
                    break;
                }
            }
            selected
        };

        tracing::info!(
            "[StrategyDispatcher] Selected proactive mode: {} (weights: TODO={:.1}, TOPIC={:.1}, SCREEN={:.1})",
            selected_mode,
            todo_w,
            topic_w,
            screen_w
        );

        match selected_mode {
            "TODO" => {
                if let Some(prompt) = self.get_todo_prompt(game_status, settings) {
                    return Some((prompt, IntentType::Todo));
                }
                // 没有 Todo 时降级到 TOPIC
                if config.enable_topic_creator {
                    return Some((self.get_topic_prompt(game_status), IntentType::Topic));
                }
                None
            },
            "SCREEN" => {
                if let Some(prompt) = self.get_screen_prompt(game_status).await {
                    return Some((prompt, IntentType::Screen));
                }
                // SCREEN 抓取失败或接口失败时降级到 TOPIC
                if config.enable_topic_creator {
                    return Some((self.get_topic_prompt(game_status), IntentType::Topic));
                }
                None
            },
            _ => Some((self.get_topic_prompt(game_status), IntentType::Topic)),
        }
    }

    fn get_todo_prompt(
        &self,
        game_status: &GameStatus,
        settings: &UserScheduleSettings,
    ) -> Option<String> {
        let todo_groups = settings.todo_groups.as_ref()?;
        let mut candidates = Vec::new();
        let now = Local::now();

        for group in todo_groups.values() {
            for todo in &group.todos {
                if !todo.completed && todo.priority >= 1 {
                    if let Some(time_context) = todo_time_context_at(todo, now.naive_local()) {
                        candidates.push((todo, time_context));
                    }
                }
            }
        }

        if candidates.is_empty() {
            return None;
        }

        let mut rng = rand::thread_rng();
        let idx = rng.gen_range(0..candidates.len());
        let (selected, time_context) = &candidates[idx];
        let user_name = &game_status.player.user_name;

        Some(format!(
            "{{当前绝对时间：{}（时区 {}）。{}有一个未完成任务：'{}'；{}。可以自然询问一次，但必须按绝对时间判断过去/未来，禁止把旧的‘明天’重新解释为现在的明天。}}",
            now.format("%Y-%m-%d %H:%M:%S"),
            now.offset(),
            user_name,
            selected.text,
            time_context
        ))
    }

    async fn get_screen_prompt(&self, game_status: &GameStatus) -> Option<String> {
        let analyze_prompt = "你是一个图像信息转述者，你将需要把你看到的画面描述给另一个AI让他理解用户的图片内容。用户开放了那个AI的自主窥屏功能，请获取桌面画面中的重点内容，用200字描述主体部分即可。如果你看到一个聊天窗口，有角色的立绘和对话框，不要描述这部分，只描述桌面上的其他内容。因为那部分是玩家与AI的聊天窗口。";

        let analysis = self
            .screen_analyzer
            .lock()
            .await
            .analyze_screen(analyze_prompt)
            .await?;

        let user_name = &game_status.player.user_name;
        let ai_name = game_status
            .current_role_id
            .and_then(|rid| game_status.role_manager.get_loaded(rid))
            .and_then(|role| role.display_name.clone())
            .unwrap_or_else(|| "你".to_string());

        Some(format!(
            "{{ {} 偷看了一眼 {} 的电脑桌面: {} }}",
            ai_name, user_name, analysis
        ))
    }

    fn get_topic_prompt(&self, game_status: &GameStatus) -> String {
        let ai_name = game_status
            .current_role_id
            .and_then(|rid| game_status.role_manager.get_loaded(rid))
            .and_then(|role| role.display_name.clone())
            .unwrap_or_else(|| "你".to_string());

        format!("{{ {} 想继续说话了}}", ai_name)
    }
}

#[cfg(test)]
mod temporal_todo_tests {
    use super::*;

    fn todo(text: &str, deadline: Option<&str>) -> TodoItem {
        TodoItem {
            text: text.to_string(),
            priority: 1,
            deadline: deadline.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn proactive_todo_rejects_past_deadline() {
        let now = NaiveDateTime::parse_from_str("2026-09-23 12:00", "%Y-%m-%d %H:%M").unwrap();
        assert!(todo_time_context_at(&todo("和朋友吃饭", Some("2026-09-22")), now).is_none());
    }

    #[test]
    fn proactive_todo_rejects_unanchored_relative_text() {
        let now = NaiveDateTime::parse_from_str("2026-09-23 12:00", "%Y-%m-%d %H:%M").unwrap();
        assert!(todo_time_context_at(&todo("明天和朋友吃饭", None), now).is_none());
        assert!(todo_time_context_at(&todo("整理书桌", None), now).is_some());
    }
}
