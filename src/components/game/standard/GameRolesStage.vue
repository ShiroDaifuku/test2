<template>
  <div class="absolute h-full w-full overflow-hidden">
    <!-- 1. 每个角色保留原有静态视觉、气泡和触摸层 -->
    <RoleAvatar
      v-for="role in gameStore.presentRolesList"
      :key="role.roleId"
      :role="role"
      :cast-scale="castScale"
      :cast-offset-y="castOffsetY"
    />

    <!-- 2. 场景光照叠加层 -->
    <div
      v-if="lightOverlayStyle"
      class="pointer-events-none absolute inset-0 z-10"
      :style="lightOverlayStyle as any"
    ></div>

    <!-- 3. 全局主语音播放器 -->
    <audio ref="mainAudio" @ended="onAudioEnded"></audio>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from "vue";
  import { useGameStore } from "@/stores/modules/game";
  import { useUIStore } from "@/stores/modules/ui/ui";
  import { getVoiceAudio } from "@/api/services/game-info";
  import RoleAvatar from "./GameRoleAvatar.vue";

  const gameStore = useGameStore();
  const uiStore = useUIStore();
  const emit = defineEmits(["audio-ended", "audio-started"]);

  /** 投屏全局缩放与偏移（仅投屏窗口传入；主窗口缺省无影响）。
    水平偏移由投屏窗口 .cast-role-layer 的 CSS translateX 整层平移，不在此处理。 */
  const props = withDefaults(
    defineProps<{
      /** 投屏全局缩放（作用于立绘布局，保持贴底定位） */
      castScale?: number;
      /** 投屏全局垂直偏移（像素，正值下移；布局内夹紧，下移触底即止） */
      castOffsetY?: number;
    }>(),
    { castScale: 1, castOffsetY: 0 }
  );

  const mainAudio = ref<HTMLAudioElement | null>(null);
  const voiceDataUrl = ref("");

  const lightOverlayStyle = computed(() => {
    const l = gameStore.currentScene?.lighting;
    if (!l?.overlay_enabled) return undefined;
    if (l.overlay_target !== "character" && l.overlay_target !== "both") return undefined;
    const blend = l.blend_mode !== "normal" ? l.blend_mode : "overlay";
    return `background: radial-gradient(circle at ${l.light_x}% ${l.light_y}%, ${l.overlay_color1} 0%, ${l.overlay_color2} ${l.overlay_radius}%); mix-blend-mode: ${blend}; opacity: ${l.overlay_opacity}`;
  });

  // --- 音频逻辑 (全局) ---
  // 监听 UI Store 的音频播放指令
  watch(
    () => uiStore.currentAvatarAudio,
    async (newAudio) => {
      if (!mainAudio.value) return;

      // 如果设置为 'None'，停止当前播放
      if (newAudio === "None" || !newAudio) {
        voiceDataUrl.value = "";
        mainAudio.value.pause();
        mainAudio.value.currentTime = 0;
        return;
      }

      if (newAudio && newAudio !== "None") {
        try {
          const dataUrl = await getVoiceAudio(newAudio);
          voiceDataUrl.value = dataUrl;
          mainAudio.value.src = dataUrl;
          mainAudio.value.load();
          mainAudio.value.volume = uiStore.characterVolume / 100;
          mainAudio.value
            .play()
            .then(() => {
              emit("audio-started");
            })
            .catch((e) => {
              console.error("播放失败", e);
            });
        } catch (e) {
          console.error("获取语音文件失败:", e);
        }
      }
    }
  );

  watch(
    () => uiStore.characterVolume,
    (v) => {
      if (mainAudio.value) mainAudio.value.volume = v / 100;
    }
  );

  const onAudioEnded = () => {
    emit("audio-ended");
  };

  // 暴露停止音频的方法给父组件
  const stopAudio = () => {
    if (mainAudio.value) {
      mainAudio.value.pause();
      mainAudio.value.currentTime = 0;
    }
  };

  defineExpose({
    stopAudio,
  });
</script>

<style scoped></style>
