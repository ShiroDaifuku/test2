import { invoke } from "@tauri-apps/api/core";
import { invalidateDsEmotionSetting } from "@/api/ds-emotion";
import { invalidateCloudSettings } from "@/api/ds-cloud-sync";

export type StructuredConfig = Record<string, any>;

// 单个配置项的类型
export interface ConfigItem {
  key: string;
  value: string;
  description: string;
  type: "text" | "bool" | "textarea" | "path" | "number";
}

export async function fetchEnvConfig(): Promise<StructuredConfig> {
  return invoke("get_settings_tree");
}

export async function saveEnvConfig(values: Record<string, string>): Promise<string> {
  const r = await invoke<string>("save_settings", { values });
  // DS娘 v0.4：设置一改就清缓存，否则"情绪兜底""云同步"这类开关要重启才生效
  try {
    invalidateDsEmotionSetting();
    invalidateCloudSettings();
  } catch (e) {
    /* 清缓存失败不影响保存结果 */
  }
  return r;
}

/**
 * 设置 HDR 模式开关（仅 Windows）。
 * 持久化到后端 settings.json，启动时由 Rust 侧读取并决定 WebView2 色彩配置，重启后生效。
 */
export async function setHdrMode(enabled: boolean): Promise<void> {
  return invoke("set_hdr_mode", { enabled });
}

export const getEnvConfigByKey = async (key: string): Promise<ConfigItem> => {
  try {
    const data = await invoke("get_setting_by_key", { key });
    return data as ConfigItem;
  } catch (error) {
    console.error("Error fetching config by key:", error);
    throw error;
  }
};

export const getEnvConfigSettings = async (): Promise<StructuredConfig> => {
  try {
    const data = await invoke("get_settings_tree");
    return data as StructuredConfig;
  } catch (error) {
    console.error("Error fetching config env settings:", error);
    throw error;
  }
};

export const saveEnvConfigSettings = async (
  values: Record<string, string>
): Promise<{ status: string; message: string }> => {
  try {
    const message = await invoke("save_settings", { values });
    return { status: "success", message: message as string };
  } catch (error) {
    console.error("Error modifying config env settings:", error);
    throw error;
  }
};
