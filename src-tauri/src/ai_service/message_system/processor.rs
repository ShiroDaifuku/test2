//! 消息预处理器：对标 Python `MessageProcessor`。
//!
//! 关键能力：
//! - `append_user_message`：给用户消息追加 `{系统提醒: ...}` 段（时间/桌面/大括号/Temp）。
//! - `parse_and_classify_emotional_segments`：把 AI 回复里的 `【情绪】正文<日语>（动作）`
//!   切成结构化 segment。
//!
//! 与旧版的差异：
//! - 桌面分析（`DesktopAnalyzer`）暂不移植。
//! - 情绪预测：使用 [`EmotionClassifier`]（ONNX）；未注入时 fallback 为 `original_tag`。

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::Local;
use regex::Regex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ai_service::emotion::EmotionClassifier;

/// 单个情绪片段。字段与旧版 `parse_and_classify_emotional_segments` 返回一致。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EmotionSegment {
    pub index: usize,
    pub original_tag: String,
    pub following_text: String,
    pub motion_text: String,
    pub japanese_text: String,
    /// 情绪分类器的预测 label。未启用时等于 `original_tag`。
    pub predicted: String,
    pub confidence: f64,
    pub voice_file: String,

    /// 关联角色信息（由 consumer 填充）
    pub character: Option<String>,
    pub role_id: Option<i32>,
}

/// 处理用户消息的结果。
#[derive(Debug, Clone, Default)]
pub struct UserMessageOutcome {
    pub main: String,
    pub temp: Option<String>,
}

/// 单例 Regex 缓存。
fn emotion_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"【([^】]*)】([^【】]*)").expect("invalid regex"))
}
fn japanese_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<([^>]*)>").expect("invalid regex"))
}
fn motion_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"（([^）]*)）").expect("invalid regex"))
}
fn bracket_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{([^}]+)\}").expect("invalid regex"))
}
fn temp_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)\[!Temp!\](.*?)\[/!Temp!\]").expect("invalid regex"))
}
fn strip_jp_action_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>|（[^）]*）").expect("invalid regex"))
}

/// 把模型输出的【情绪】标签规整为前端已知的短情绪词。
///
/// iOS 上 ort/ONNX 情绪分类器可能不可用（见 Cargo.toml 的 iOS 依赖缺失），
/// 分类器禁用时 predicted 会回退为原始标签，导致情绪变成模型随手写的一整段
/// （如“我高兴的走过来”）。这里做白名单兜底，保证情绪永远是短标签。
fn normalize_emotion_tag(raw: &str) -> String {
    // 去空白与常见标点，仅保留可用于关键词匹配的文本
    let t: String = raw
        .chars()
        .filter(|c| {
            !c.is_whitespace()
                && !matches!(
                    c,
                    '【' | '】' | '，' | ',' | '。' | '.' | '！' | '!' | '？' | '?' | '…' | '~' | '～'
                )
        })
        .collect();
    let t = t.trim();
    if t.is_empty() {
        return "正常".to_string();
    }

    // 顺序重要：更具体的放前面；命中即返回。输出必须落在前端
    // EMOTION_CONFIG_EMO 的已知键里（避免出现前端无法映射的情绪）。
    //
    // DS娘 v0.4 修正：上游这里把「无语」「尴尬」原样返回，但前端映射表没有这两个键
    //   → 立绘直接回退成「正常」（提示词白名单里恰好就是这两个词，所以触发非常频繁）。
    //   现改为映射到前端已知的「无奈」「难为情」，并顺带扩充同义词，减少"认不出→正常"。
    const MAP: &[(&str, &str)] = &[
        // 厌恶
        ("厌恶", "厌恶"),
        ("嫌弃", "厌恶"),
        ("讨厌", "厌恶"),
        ("厌烦", "厌恶"),
        ("烦躁", "厌恶"),
        ("恶心", "厌恶"),
        // 生气
        ("生气", "生气"),
        ("愤怒", "生气"),
        ("气恼", "生气"),
        ("恼火", "生气"),
        ("不爽", "生气"),
        ("火大", "生气"),
        // 伤心
        ("难过", "伤心"),
        ("悲伤", "伤心"),
        ("流泪", "伤心"),
        ("哭泣", "哭泣"),
        ("伤心", "伤心"),
        ("失落", "伤心"),
        ("沮丧", "伤心"),
        ("委屈", "伤心"),
        ("郁闷", "伤心"),
        ("低落", "伤心"),
        // 害怕
        ("害怕", "害怕"),
        ("恐惧", "害怕"),
        ("惊恐", "害怕"),
        ("惊吓", "害怕"),
        ("畏惧", "害怕"),
        // 难为情（前端键名是「难为情」，立绘文件是「羞耻」）
        ("难为情", "难为情"),
        ("尴尬", "难为情"),
        ("羞耻", "难为情"),
        ("羞愧", "难为情"),
        ("不好意思", "难为情"),
        ("害臊", "难为情"),
        // 害羞
        ("害羞", "害羞"),
        ("羞涩", "害羞"),
        ("羞怯", "害羞"),
        ("腼腆", "害羞"),
        // 惊讶
        ("惊讶", "惊讶"),
        ("吃惊", "惊讶"),
        ("震惊", "惊讶"),
        ("惊愕", "惊讶"),
        ("意外", "惊讶"),
        // 紧张
        ("紧张", "紧张"),
        ("忐忑", "紧张"),
        ("局促", "紧张"),
        ("拘谨", "紧张"),
        // 担心
        ("担忧", "担心"),
        ("担心", "担心"),
        ("焦虑", "担心"),
        ("不安", "担心"),
        ("牵挂", "担心"),
        ("忧心", "担心"),
        // 疑惑
        ("困惑", "疑惑"),
        ("疑问", "疑惑"),
        ("疑惑", "疑惑"),
        ("好奇", "疑惑"),
        ("迷惑", "疑惑"),
        // 认真
        ("认真", "认真"),
        ("严肃", "认真"),
        ("专注", "认真"),
        ("郑重", "认真"),
        // 自信
        ("自信", "自信"),
        ("得意", "自信"),
        ("骄傲", "自信"),
        ("自豪", "自信"),
        ("炫耀", "自信"),
        // 调皮
        ("撒娇", "调皮"),
        ("调皮", "调皮"),
        ("淘气", "调皮"),
        ("顽皮", "调皮"),
        ("坏笑", "调皮"),
        ("恶作剧", "调皮"),
        // 慌张
        ("慌乱", "慌张"),
        ("慌张", "慌张"),
        ("惊慌", "慌张"),
        ("手足无措", "慌张"),
        ("措手不及", "慌张"),
        // 高兴
        ("开心", "高兴"),
        ("愉快", "高兴"),
        ("喜悦", "高兴"),
        ("高兴", "高兴"),
        ("快乐", "高兴"),
        ("欢快", "高兴"),
        ("欣慰", "高兴"),
        ("笑意", "高兴"),
        // 兴奋
        ("兴奋", "兴奋"),
        ("激动", "兴奋"),
        ("亢奋", "兴奋"),
        ("雀跃", "兴奋"),
        ("期待", "兴奋"),
        // 心动（前端键名是「心动」，上游提示词写的是「情动」）
        ("情动", "心动"),
        ("心动", "心动"),
        ("喜欢", "心动"),
        ("爱意", "心动"),
        ("宠溺", "心动"),
        // 无奈（前端键名是「无奈」，上游这里原本返回「无语」，前端没有该键）
        ("无奈", "无奈"),
        ("无语", "无奈"),
        ("没办法", "无奈"),
        ("没辙", "无奈"),
        ("扶额", "无奈"),
        ("叹气", "无奈"),
        // 平静（前端把「平静」映射到「正常」）
        ("平静", "平静"),
        ("冷静", "平静"),
        ("淡然", "平静"),
        ("安心", "平静"),
        ("释然", "平静"),
        ("淡定", "平静"),
        // 正常
        ("正常", "正常"),
    ];

    for (keyword, canonical) in MAP {
        if t.contains(keyword) {
            return canonical.to_string();
        }
    }

    "正常".to_string()
}

/// MessageProcessor 配置。
#[derive(Debug, Clone, Copy)]
pub struct ProcessorOptions {
    pub time_sense_enabled: bool,
    /// 对应旧版 `ENABLE_TRANSLATE`。关闭时 `japanese_text` 会回退为 cleaned_text。
    pub enable_translate: bool,
}

impl Default for ProcessorOptions {
    fn default() -> Self {
        Self {
            time_sense_enabled: true,
            enable_translate: false,
        }
    }
}

/// MessageProcessor：无状态逻辑 + 少量时间感知计数。
pub struct MessageProcessor {
    options: ProcessorOptions,
    inner: Mutex<ProcessorInner>,
    classifier: Option<Arc<EmotionClassifier>>,
}

struct ProcessorInner {
    last_time: Instant,
    sys_time_counter: u32,
}

impl MessageProcessor {
    pub fn new(options: ProcessorOptions, classifier: Option<Arc<EmotionClassifier>>) -> Self {
        Self {
            options,
            inner: Mutex::new(ProcessorInner {
                last_time: Instant::now(),
                sys_time_counter: 0,
            }),
            classifier,
        }
    }

    /// 解析并分类情绪片段。语义对应 Python `parse_and_classify_emotional_segments`。
    pub fn parse_and_classify_emotional_segments(&self, text: &str) -> Vec<EmotionSegment> {
        let mut results: Vec<EmotionSegment> = Vec::new();

        // 前处理：修复标签并清理非法内容
        let text = Self::preprocess_text(text);

        let re = emotion_re();
        let mut i = 0usize;

        for cap in re.captures_iter(&text) {
            i += 1;
            let raw_emotion = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let emotion_tag = normalize_emotion_tag(raw_emotion);
            let following_raw = cap.get(2).map(|m| m.as_str()).unwrap_or("");
            let following_text = following_raw.replace('(', "（").replace(')', "）");

            let japanese_text = japanese_re()
                .captures(&following_text)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();

            // 修复：如果japanese_text包含波浪号，修复它
            let japanese_text = japanese_text.replace('~', "。");
            let motion_text = motion_re()
                .captures(&following_text)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();

            let cleaned_text = strip_jp_action_re()
                .replace_all(&following_text, "")
                .trim()
                .to_string();

            // 翻译关闭：cleaned_text 即 japanese_text
            let japanese_text = if !self.options.enable_translate {
                cleaned_text.clone()
            } else if !japanese_text.is_empty() {
                // 清理：去掉可能出现在日文里的 情绪/动作 片段
                let step1 = motion_re().replace_all(&japanese_text, "");
                let step2 = Regex::new(r"【[^】]*】").unwrap().replace_all(&step1, "");
                step2.trim().replace('~', "。")
            } else {
                japanese_text
            };

            if cleaned_text.is_empty() && japanese_text.is_empty() && motion_text.is_empty() {
                continue;
            }

            // 情绪分类器：有分类器走 ONNX，否则回退为原 tag。
            let (predicted, confidence) = match self.classifier.as_ref() {
                Some(clf) => {
                    let p = clf.predict(&emotion_tag, None);
                    (p.label, p.confidence as f64)
                },
                None => (emotion_tag.to_string(), 1.0),
            };

            let voice_file = format!("{}_part_{}.wav", Uuid::new_v4(), i);

            results.push(EmotionSegment {
                index: i,
                original_tag: emotion_tag.to_string(),
                following_text: cleaned_text,
                motion_text,
                japanese_text,
                predicted,
                confidence,
                voice_file,
                character: None,
                role_id: None,
            });
        }

        if results.is_empty() {
            tracing::warn!("未在文本中找到【】格式的情绪标签");
        }

        results
    }

    /// 文本预处理：修复标签、清理非法内容
    fn preprocess_text(text: &str) -> String {
        let mut processed = text.to_string();

        // 3. 清理违规内容
        // 删除 {} 内容
        let curly_re = Regex::new(r"\{[^{}]*\}").unwrap();
        processed = curly_re.replace_all(&processed, "").to_string();

        // 1. 统一括号风格（不转换书名号，书名号单独处理）
        processed = processed.replace('＜', "<").replace('＞', ">");

        // 移除书名号《》（保留内容，避免被误识别为日文标签）
        processed = processed.replace('《', "").replace('》', "");

        // 2. 修复未闭合标签（不使用正则前瞻）
        processed = Self::fix_unclosed_tags(&processed);

        processed
    }

    fn fix_unclosed_tags(text: &str) -> String {
        let mut result = String::with_capacity(text.len() + 10);
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;

        while i < chars.len() {
            if chars[i] == '<' {
                i += 1;

                // 收集标签内容（直到遇到 '>' 或 '\n'）
                let mut tag_content = String::new();
                while i < chars.len() && chars[i] != '>' && chars[i] != '\n' {
                    tag_content.push(chars[i]);
                    i += 1;
                }

                // 检查当前位置是否是 '>'
                let is_closed = i < chars.len() && chars[i] == '>';

                // 重建标签
                result.push('<');
                result.push_str(&tag_content);

                if is_closed {
                    result.push('>');
                    i += 1; // 跳过 '>'
                } else {
                    // 未闭合，补全 '>'
                    result.push('>');
                    // i 在换行符或结束位置，不要额外移动
                }
            } else {
                result.push(chars[i]);
                i += 1;
            }
        }

        result
    }

    /// 处理用户消息，提取 `{...}` 旁白、`[!Temp!]...[/!Temp!]` 临时指令，拼接系统提醒。
    pub async fn append_user_message(&self, user_message: &str) -> UserMessageOutcome {
        let mut processed_message = user_message.to_string();
        let mut user_instruction_part = String::new();
        let mut temp_instruction_part = String::new();

        // 大括号
        let bracket_matches: Vec<String> = bracket_re()
            .captures_iter(user_message)
            .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
            .collect();
        if !bracket_matches.is_empty() {
            processed_message = bracket_re()
                .replace_all(&processed_message, "")
                .trim()
                .to_string();
            user_instruction_part = format!("旁白: {}", bracket_matches.join("; "));
        }

        // [!Temp!]..
        let temp_matches: Vec<String> = temp_re()
            .captures_iter(user_message)
            .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
            .collect();
        if !temp_matches.is_empty() {
            processed_message = temp_re()
                .replace_all(&processed_message, "")
                .trim()
                .to_string();
            let pieces: Vec<String> = temp_matches.iter().map(|m| format!("${m}$")).collect();
            temp_instruction_part = pieces.join("%");
        }

        // 时间感知
        let now = Instant::now();
        let mut sys_time_part = String::new();
        if self.options.time_sense_enabled {
            let (should_emit, _reset) = {
                let inner = self.inner.lock().unwrap();
                let long_enough = now.duration_since(inner.last_time) > Duration::from_secs(3600);
                (long_enough || inner.sys_time_counter < 1, long_enough)
            };
            if should_emit {
                let formatted = Local::now().format("%Y/%m/%d %H:%M").to_string();
                sys_time_part = format!("{formatted} ");
            }
        }

        // 构建系统提醒
        let mut system_parts: Vec<String> = Vec::new();
        let mut sys_flag = false;
        if !sys_time_part.is_empty() {
            system_parts.push(sys_time_part);
            sys_flag = true;
        }
        if !user_instruction_part.is_empty() {
            system_parts.push(user_instruction_part.clone());
        }
        if !temp_instruction_part.is_empty() {
            system_parts.push(temp_instruction_part.clone());
        }

        if !system_parts.is_empty() {
            let prefix = if sys_flag { "系统提醒: " } else { "" };
            processed_message.push_str(&format!("\n{{{}{}}}", prefix, system_parts.join(" ")));
        }

        // 更新计数
        {
            let mut inner = self.inner.lock().unwrap();
            inner.last_time = now;
            inner.sys_time_counter = inner.sys_time_counter.saturating_add(1);
            if inner.sys_time_counter >= 2 {
                inner.sys_time_counter = 0;
            }
        }

        tracing::info!("处理后的用户信息是: {processed_message}");
        UserMessageOutcome {
            main: processed_message,
            temp: if temp_instruction_part.is_empty() {
                None
            } else {
                Some(temp_instruction_part)
            },
        }
    }
}

/// `Function.fix_ai_generated_text`：规范化带情绪标签的文本。语义 1:1 对照。
pub fn fix_ai_generated_text(text: &str) -> String {
    let text = text
        .replace('＜', "<")
        .replace('＞', ">")
        .replace('《', "")
        .replace('》', "");
    let re = emotion_re();
    let mut parts: Vec<String> = Vec::new();
    let mut has_any = false;
    for cap in re.captures_iter(&text) {
        has_any = true;
        let raw_emotion = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let emotion_tag = normalize_emotion_tag(raw_emotion);
        let full_tag = format!("【{emotion_tag}】");
        let following_raw = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        let following_text = following_raw.replace('(', "（").replace(')', "）");

        let japanese_text = japanese_re()
            .captures(&following_text)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let motion_text = motion_re()
            .captures(&following_text)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let cleaned_text = strip_jp_action_re()
            .replace_all(&following_text, "")
            .trim()
            .to_string();

        let japanese_text = if !japanese_text.is_empty() {
            motion_re()
                .replace_all(&japanese_text, "")
                .trim()
                .to_string()
        } else {
            japanese_text
        };
        let japanese_text = japanese_text.replace('~', "。");

        let mut normalized = full_tag;
        if !cleaned_text.is_empty() {
            normalized.push_str(&cleaned_text);
        }
        if !japanese_text.is_empty() {
            normalized.push('<');
            normalized.push_str(&japanese_text);
            normalized.push('>');
        }
        if !motion_text.is_empty() {
            normalized.push('（');
            normalized.push_str(&motion_text);
            normalized.push('）');
        }

        if !cleaned_text.is_empty() || !japanese_text.is_empty() {
            parts.push(normalized);
        }
    }

    if !has_any {
        return text.to_string();
    }
    parts.concat()
}
