import { createRouter, createWebHistory } from "vue-router";
import { isMobile } from "../utils/platform";
import { invoke } from "@tauri-apps/api/core";
import { useGameStore } from "../stores/modules/game";
import { applyWebInitData } from "../stores/modules/game/actions";
import type { WebInitData } from "../api/services/game-info";

// 导入你的组件
// 为了性能，这里我们使用路由懒加载 (lazy-loading)
// 这意味着 Credits.vue 组件只会在用户访问 /credit 路径时才会被加载
const Credits = () => import("../components/views/Credits.vue");
const ComapionMode = () => import("../components/views/CompanionMode.vue");
const MainMenu = () => import("../components/views/MainMenu.vue");
const PetMode = () => import("../components/views/PetMode.vue");
const Second = () => import("../components/views/Second.vue");
const LogWindow = () => import("../components/views/LogWindow.vue");
const CastWindow = () => import("../components/views/CastWindow.vue");
// 剧本编辑器体量较大，必须懒加载 —— 项目没有配 manualChunks，
// 非懒加载的 view 会整个进主 chunk
const ScriptEditor = () => import("../components/views/ScriptEditor.vue");
// 云端创意工坊（主菜单「创意工坊」二级菜单进入，原设置页 workshop 标签迁移）
const WorkshopPage = () => import("../components/views/WorkshopPage.vue");

// 1. 定义路由表
const routes = [
  {
    path: "/",
    name: "MainMenu",
    component: MainMenu,
  },
  {
    path: "/chat",
    name: "LingChat",
    component: ComapionMode,
  },
  {
    path: "/credit",
    name: "Credits",
    component: Credits,
  },
  {
    path: "/pet",
    name: "PetMode",
    component: PetMode,
  },
  {
    path: "/second",
    name: "Second",
    component: Second,
  },
  {
    path: "/log-window",
    name: "LogWindow",
    component: LogWindow,
  },
  {
    path: "/cast",
    name: "CastWindow",
    component: CastWindow,
  },
  {
    path: "/script-editor",
    name: "ScriptEditor",
    component: ScriptEditor,
  },
  {
    path: "/workshop",
    name: "WorkshopPage",
    component: WorkshopPage,
  },
];

// 2. 创建路由实例
const router = createRouter({
  // 使用 HTML5 History 模式，URL会更美观（例如：http://localhost:5173/credit）
  // 而不是 hash 模式 (http://localhost:5173/#/credit)
  history: createWebHistory(),
  routes, // `routes: routes` 的缩写
});

// 移动端启动直接进入自由对话模式（跳过主菜单），并自动恢复最近的自动存档
router.beforeEach(async (to) => {
  if (isMobile() && to.path === "/") {
    try {
      const { saves } = await invoke<{ saves: Array<{ id: number }>; total: number }>(
        "list_saves",
        { page: 1, pageSize: 1 }
      );
      if (saves && saves.length > 0) {
        const gameInfo = await invoke<WebInitData>("load_save", { saveId: saves[0].id });
        applyWebInitData(useGameStore().$state, gameInfo);
      }
    } catch (e) {
      // 无存档或加载失败时直接进自由对话，不阻断启动
      console.warn("[router] 自动恢复最近存档失败，直接进入自由对话:", e);
    }
    return "/chat";
  }
});

// 3. 导出路由实例
export default router;
