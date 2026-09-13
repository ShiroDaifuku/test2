import { createApp } from "vue";
import pinia from "./stores";
import { initializeEventProcessors } from "./core/events";
import { initializeTauriEventListeners } from "./api/tauri-events";

import App from "./App.vue";
import "./assets/styles/base.css";
import "./assets/styles/variables.css";
import { i18n } from "./locales";

// WebSocket handlers 保留用于未来剧本模式参考
// import "./api/websocket/handlers/script-handler";
// import "./api/websocket/handlers/adventure-handler";

import { getCurrentWindow } from "@tauri-apps/api/window";
import router from "./router";
import { autoConfigurePerformance } from "./api/services/cpu-perf";
import { initAudioOutputManager } from "./utils/audioOutputManager";
import { bootstrapDeepSeek } from "./api/ds-bootstrap";
import { scheduleCloudSync } from "./api/ds-cloud-sync";

// 仅主窗口启动时清除加载过渡标记，避免设置窗口等其他窗口误清除
if (getCurrentWindow().label === "main") {
  localStorage.removeItem("lingchat_loading_shown");
}

const app = createApp(App);

initializeEventProcessors();

// v0.4 减法后只保留主窗口（投屏 cast 已移除）
initializeTauriEventListeners();

app.use(pinia);
app.use(i18n);
app.use(router);

// 独立日志窗口：通过 index.html?window=log 打开时直接进入日志路由
if (new URLSearchParams(window.location.search).get("window") === "log") {
  router.replace("/log-window");
}

app.mount("#app");

// DS娘 v0.4：自举 DeepSeek 供应商（幂等，已有配置则跳过；失败不影响启动）
void bootstrapDeepSeek();

// DS娘 v0.4：启动时静默云同步（延迟 3 秒，避免和初始化抢资源；失败静默）
setTimeout(() => scheduleCloudSync("startup"), 3000);

// 初始化全局音频输出设备管理器（需 pinia 就绪）
initAudioOutputManager();

// 延迟执行 CPU+GPU 画质自适应，确保 pinia store 已就绪
setTimeout(autoConfigurePerformance, 1000);
