<template>
  <audio ref="audio1" @ended="handleEnded(1)"></audio>
  <audio ref="audio2" @ended="handleEnded(2)"></audio>
</template>

<script setup lang="ts">
  import { ref, watch, onMounted, onBeforeUnmount } from "vue";

  const props = withDefaults(
    defineProps<{
      src?: string | null;
      volume?: number; // 0-100 音量
      paused?: boolean;
      stopped?: boolean;
      duration?: number; // 淡入淡出时长 (毫秒)
      loop?: boolean; // 是否循环播放（单曲循环直接走原生 loop，iOS 上避免 ended 后重播被手势策略拦截）
      rate?: number; // 播放速度倍率（1.0 原速），由剧本 music 事件的 playbackSpeed 控制
    }>(),
    {
      src: "",
      volume: 100,
      paused: false,
      stopped: false,
      duration: 800,
      loop: false,
      rate: 1,
    }
  );

  const emit = defineEmits<{
    (e: "ended"): void;
  }>();

  const audio1 = ref<HTMLAudioElement | null>(null);
  const audio2 = ref<HTMLAudioElement | null>(null);

  const FADE_INTERVAL = 50;
  const PLAY_RETRY_MS = 300;
  const MAX_RETRIES = 40; // 最多自动重试约 12 秒，覆盖资源/解码临时未就绪

  /** 设置播放速度。HTML audio.playbackRate 可随时改、立即生效；非法值兜底为 1 */
  const applyRate = (el: HTMLAudioElement | null) => {
    if (!el) return;
    const r = props.rate;
    el.playbackRate = typeof r === "number" && r > 0 ? r : 1;
  };

  /** 把 loop 状态同步到原生音频元素。
   *  单曲循环必须用原生 loop，而不是 ended 后再 play()：
   *  iOS/WKWebView 上 ended 后的「重新开始」会被当作新的自动播放而拦截。 */
  const syncLoop = () => {
    for (const el of [audio1.value, audio2.value]) {
      if (el) el.loop = !!props.loop;
    }
  };

  let activeIndex = 1; // 1 或 2，表示当前主音频
  let fadeIntervalId: ReturnType<typeof setInterval> | null = null;
  /** 正在淡入的目标 URL（None=仅淡出）；暂停期间保留，恢复时续接而不是放错轨道 */
  let fadeTargetUrl: string | null | undefined = null;
  let disposed = false;

  const clearFade = () => {
    if (fadeIntervalId !== null) {
      clearInterval(fadeIntervalId);
      fadeIntervalId = null;
    }
  };

  onBeforeUnmount(() => {
    disposed = true;
    clearFade();
    removeGestureListeners();
  });

  const getEl = (index: number): HTMLAudioElement | null =>
    index === 1 ? audio1.value : audio2.value;

  const shouldSound = (): boolean => !props.paused && !props.stopped;

  const clampVolume = (v: number): number => Math.max(0, Math.min(1, (v ?? 100) / 100));

  // ---------- 播放失败兜底：限次重试 + 全局手势续播 ----------
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryCount = 0;
  };

  const removeGestureListeners = () => {
    window.removeEventListener("pointerdown", onUserGesture, { capture: true } as any);
    window.removeEventListener("touchstart", onUserGesture, { capture: true } as any);
    window.removeEventListener("keydown", onUserGesture, { capture: true } as any);
  };

  const armGestureFallback = () => {
    removeGestureListeners();
    // 任何一次真实的用户交互都在事件回调内同步尝试续播，
    // 保证 iOS 用户手势链内执行 play()（watcher 异步触发的 play 可能已失去激活状态）。
    window.addEventListener("pointerdown", onUserGesture, { capture: true });
    window.addEventListener("touchstart", onUserGesture, { capture: true });
    window.addEventListener("keydown", onUserGesture, { capture: true });
  };

  const onUserGesture = () => {
    if (!shouldSound() || disposed) return;
    const target =
      fadeTargetUrl && fadeTargetUrl !== "None"
        ? getEl(activeIndex === 1 ? 2 : 1)
        : getEl(activeIndex);
    if (target && target.src && target.paused && !target.ended) {
      target.volume = clampVolume(props.volume);
      tryPlay(target);
    }
  };

  const handlePlayBlocked = (el: HTMLAudioElement | null, err: unknown) => {
    if (!shouldSound() || disposed) return;
    console.warn("音频播放被拦截，将自动重试/等待首次交互:", err);
    armGestureFallback();
    scheduleRetry(el);
  };

  const scheduleRetry = (el: HTMLAudioElement | null) => {
    clearRetry();
    if (!shouldSound() || !el || retryCount >= MAX_RETRIES) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryCount++;
      if (disposed || !shouldSound()) return;
      if (el.paused && !el.ended) tryPlay(el);
    }, PLAY_RETRY_MS);
  };

  const tryPlay = (el: HTMLAudioElement | null) => {
    if (!el || disposed) return;
    if (!shouldSound()) return;
    try {
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch((e) => handlePlayBlocked(el, e));
      }
    } catch (e) {
      handlePlayBlocked(el, e);
    }
  };

  // 只派发当前主音频轨道的结束事件，忽略备用轨道的事件。
  // 循环模式走原生 loop（结束事件根本不会触发），不会出现 iOS 重播被拦。
  const handleEnded = (index: number) => {
    if (index !== activeIndex) return;
    if (props.loop) {
      // 双保险：理论上原生 loop 已生效；个别 WebView 忽略 loop 属性时手动复位续播
      const activeAudio = getEl(activeIndex);
      if (activeAudio && shouldSound()) {
        activeAudio.currentTime = 0;
        tryPlay(activeAudio);
      }
      return;
    }
    emit("ended");
  };

  /** 单曲淡出到静音（newUrl 为空 / "None"），结束时释放资源 */
  const fadeOutOnly = (currentAudio: HTMLAudioElement) => {
    const targetVol = clampVolume(props.volume);
    const step = targetVol / (props.duration / FADE_INTERVAL);
    fadeTargetUrl = null;
    fadeIntervalId = setInterval(() => {
      if (currentAudio.volume > 0.001) {
        currentAudio.volume = Math.max(0, currentAudio.volume - step);
      } else {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio.src = ""; // 释放资源
        clearFade();
      }
    }, FADE_INTERVAL);
  };

  /** 交叉淡入淡出到 newUrl */
  const crossFadeTo = (newUrl: string | null | undefined) => {
    clearFade(); // 立即停止前一次可能未完成的淡入淡出

    const currentAudio = getEl(activeIndex);
    const nextAudio = getEl(activeIndex === 1 ? 2 : 1);
    if (!currentAudio || !nextAudio) return;

    fadeTargetUrl = newUrl;
    const targetVol = clampVolume(props.volume);
    const step = targetVol / (props.duration / FADE_INTERVAL);

    // 1. 没有新 URL：仅停止播放并淡出
    if (!newUrl || newUrl === "None") {
      fadeOutOnly(currentAudio);
      return;
    }

    // 2. 开新轨前先停掉备用轨，避免两条轨同时出声导致「暂停只停一条」
    nextAudio.pause();
    nextAudio.currentTime = 0;
    nextAudio.src = newUrl;
    nextAudio.loop = !!props.loop;
    syncLoop();
    nextAudio.load();
    nextAudio.volume = Math.min(0.1, targetVol);
    applyRate(nextAudio); // 新轨道沿用当前播放速度

    // 只要没有被手动暂停或停止，就尝试播放备用轨道（拦截时走重试 + 手势兜底）
    if (shouldSound()) {
      tryPlay(nextAudio);
    }

    fadeIntervalId = setInterval(() => {
      let currentDone = false;
      let nextDone = false;
      const tVol = clampVolume(props.volume); // 动态目标，渐变过程中拖动音量立即生效
      const dynStep = tVol / (props.duration / FADE_INTERVAL);

      // 旧音乐淡出
      if (currentAudio.volume > 0.001) {
        currentAudio.volume = Math.max(0, currentAudio.volume - dynStep);
      } else {
        currentDone = true;
      }

      // 新音乐淡入（旧音乐归零后才开始）
      if (currentDone) {
        if (nextAudio.volume < tVol - 0.001) {
          nextAudio.volume = Math.min(tVol, nextAudio.volume + dynStep);
        } else {
          nextAudio.volume = tVol;
          nextDone = true;
        }
      }

      // 完成交接
      if (currentDone && nextDone) {
        currentAudio.pause();
        activeIndex = activeIndex === 1 ? 2 : 1; // 切换主轨道身份
        fadeTargetUrl = null;
        clearFade();
      }
    }, FADE_INTERVAL);
  };

  /** 恢复播放（暂停/拦截后）：优先续接未完成的交叉淡入目标 */
  const resumeDesired = () => {
    if (!shouldSound()) return;

    // 若暂停时正处于切歌淡入中，续接目标轨，而不是恢复已经淡出的旧轨
    if (fadeTargetUrl && fadeTargetUrl !== "None") {
      const nextAudio = getEl(activeIndex === 1 ? 2 : 1);
      if (!nextAudio) return;
      if (nextAudio.src === fadeTargetUrl) {
        nextAudio.volume = Math.max(nextAudio.volume, Math.min(0.2, clampVolume(props.volume)));
        tryPlay(nextAudio);
        if (fadeIntervalId === null) {
          // 淡入定时器已在暂停时被清掉 → 从当前音量继续淡入
          const currentAudio = getEl(activeIndex);
          if (!currentAudio) return;
          const tVol = clampVolume(props.volume);
          const dynStep = tVol / (props.duration / FADE_INTERVAL);
          fadeIntervalId = setInterval(() => {
            if (!currentAudio || !nextAudio) {
              clearFade();
              return;
            }
            let currentDone = false;
            let nextDone = false;
            if (currentAudio.volume > 0.001) {
              currentAudio.volume = Math.max(0, currentAudio.volume - dynStep);
            } else {
              currentDone = true;
            }
            if (currentDone) {
              if (nextAudio.volume < tVol - 0.001) {
                nextAudio.volume = Math.min(tVol, nextAudio.volume + dynStep);
              } else {
                nextDone = true;
              }
            }
            if (currentDone && nextDone) {
              currentAudio.pause();
              activeIndex = activeIndex === 1 ? 2 : 1;
              fadeTargetUrl = null;
              clearFade();
            }
          }, FADE_INTERVAL);
        }
        return;
      }
      // 目标轨尚未就绪（极端时序）→ 整体重来
      crossFadeTo(fadeTargetUrl);
      return;
    }

    const activeAudio = getEl(activeIndex);
    if (!activeAudio) return;
    if (!activeAudio.src) {
      // src 被停止流程清空，但仍有有效目标 → 重新加载续播
      if (props.src && props.src !== "None") {
        crossFadeTo(props.src);
      }
      return;
    }
    activeAudio.volume = clampVolume(props.volume);
    if (activeAudio.paused) tryPlay(activeAudio);
  };

  // 初始化
  onMounted(() => {
    if (props.src && props.src !== "None" && audio1.value) {
      audio1.value.src = props.src;
      audio1.value.loop = !!props.loop;
      audio1.value.volume = clampVolume(props.volume);
      applyRate(audio1.value);
      audio1.value.load();
      if (shouldSound()) {
        tryPlay(audio1.value);
      }
    }
  });

  // 监听 URL 变化触发交叉淡入淡出
  watch(
    () => props.src,
    (newUrl) => {
      clearRetry();
      if (!newUrl || newUrl === "None") {
        const currentAudio = getEl(activeIndex);
        if (currentAudio) fadeOutOnly(currentAudio);
        return;
      }
      crossFadeTo(newUrl);
    }
  );

  // 监听音量变化（渐变进行中由 interval 按目标实时跟随，无需在此处理）
  watch(
    () => props.volume,
    (newVol) => {
      if (fadeIntervalId === null) {
        for (const el of [audio1.value, audio2.value]) {
          if (el && el.src) el.volume = clampVolume(newVol);
        }
      }
    }
  );

  // 监听播放速度变化（剧本可在运行中调速）
  watch(
    () => props.rate,
    () => {
      applyRate(getEl(1));
      applyRate(getEl(2));
    }
  );

  // 循环模式开关：单曲循环直接落到原生 loop 属性
  watch(
    () => props.loop,
    () => {
      syncLoop();
    }
  );

  // 监听暂停 —— flush:'sync' 让恢复播放与点击事件同栈执行，
  // 满足 iOS/WKWebView「play() 必须在用户手势内」的约束
  watch(
    () => props.paused,
    (isPaused) => {
      if (isPaused) {
        clearFade();
        clearRetry();
        audio1.value?.pause();
        audio2.value?.pause();
      } else {
        resumeDesired();
      }
    },
    { flush: "sync" }
  );

  // 监听停止（同样同步执行，避免清空 src 时序竞争）
  watch(
    () => props.stopped,
    (isStopped) => {
      if (isStopped) {
        clearFade();
        clearRetry();
        for (const el of [audio1.value, audio2.value]) {
          if (!el) continue;
          el.pause();
          el.currentTime = 0;
          el.src = "";
        }
        fadeTargetUrl = null;
      } else {
        resumeDesired();
      }
    },
    { flush: "sync" }
  );
</script>
