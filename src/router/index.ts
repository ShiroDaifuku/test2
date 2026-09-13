import { createRouter, createWebHistory } from "vue-router";
import { isMobile } from "../utils/platform";
import { invoke } from "@tauri-apps/api/core";
import { useGameStore } from "../stores/modules/game";
import { applyWebInitData } from "../stores/modules/game/actions";
import type { WebInitData } from "../api/services/game-info";

// v0.4 减法后只保留：对话主界面（CompanionMode）与日志窗口。
// 懒加载保留（项目没有配 manualChunks，非懒加载的 view 会整个进主 chunk）。
const ComapionMode = () => import("../components/views/CompanionMode.vue");
const LogWindow = () => import("../components/views/LogWindow.vue");

// 1. 定义路由表
const routes = [
  { path: "/", redirect: "/chat" },
  { path: "/chat", name: "LingChat", component: ComapionMode },
  { path: "/log-window", name: "LogWindow", component: LogWindow },
];

// 2. 创建路由实例
const router = createRouter({
  history: createWebHistory(),
  routes,
});

// 3. 移动端启动直接进入自由对话模式，并自动恢复最近的自动存档（仅首次导航执行一次）
let saveRestored = false;
router.beforeEach(async (to) => {
  if (isMobile() && to.path === "/chat" && !saveRestored) {
    saveRestored = true;
    try {
      const { saves } = await invoke<{ saves: Array<{ id: number }>; total: number }>("list_saves", {
        page: 1,
        pageSize: 1,
      });
      if (saves && saves.length > 0) {
        const gameInfo = await invoke<WebInitData>("load_save", { saveId: saves[0].id });
        applyWebInitData(useGameStore().$state, gameInfo);
      }
    } catch (e) {
      // 无存档或加载失败时直接进自由对话，不阻断启动
      console.warn("[router] 自动恢复最近存档失败，直接进入自由对话:", e);
    }
  }
});

export default router;
