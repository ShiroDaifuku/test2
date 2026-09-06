<template>
  <div class="relative h-full w-full">
    <!-- 底层图片（当前显示的图片） -->
    <slot></slot>
    <div
      class="absolute inset-0 z-10 h-full w-full bg-no-repeat will-change-[opacity,background-image]
        backface-hidden"
      :style="{
        backgroundImage: `url(${currentImageUrl})`,
        backgroundSize: objectFit,
        backgroundPosition: position,
      }"
    ></div>

    <!-- 顶层图片（准备淡入的新图片） -->
    <!-- 新增 ref="topDivRef" 用于强制重排 -->
    <div
      ref="topDivRef"
      class="absolute inset-0 z-20 h-full w-full bg-no-repeat transition-opacity ease-in-out
        will-change-[opacity,background-image] backface-hidden"
      :class="isFadingIn ? 'opacity-100' : 'opacity-0'"
      :style="{
        backgroundImage: `url(${nextImageUrl})`,
        backgroundSize: objectFit,
        backgroundPosition: position,
        transitionDuration: `${duration}ms`,
      }"
      @transitionend="onTransitionEnd"
    ></div>
  </div>
</template>

<script setup lang="ts">
  import { ref, watch, nextTick, onBeforeUnmount } from "vue";

  const props = withDefaults(
    defineProps<{
      src: string;
      duration?: number;
      objectFit?: string;
      position?: string;
    }>(),
    {
      duration: 300,
      objectFit: "contain",
      position: "center bottom",
    }
  );

  const topDivRef = ref<HTMLElement | null>(null); // 获取顶层 DOM 的引用
  const currentImageUrl = ref("");
  const nextImageUrl = ref("");
  const isFadingIn = ref(false);

  let currentImageLoadPromise: Promise<void> | null = null;
  let disposed = false;

  onBeforeUnmount(() => {
    disposed = true;
  });

  // 背景图加载的长期自动重试（应对首启 data.7z 播种 / 慢网络等“文件稍后才出现”）：
  // - onerror → 重试；
  // - iOS asset 协议对尚不存在的文件可能既不 onload 也不 onerror（挂起）→ 看门狗超时中止重试；
  // - 只有真正加载成功才淡入切换；失败保留当前背景，绝不把坏图淡入（否则会盖成空白/透明）。
  const MAX_ATTEMPTS = 80; // 单次约 5s（4s 超时 + 1s 间隔），总窗口约 6 分钟
  const LOAD_TIMEOUT_MS = 4000;
  const RETRY_GAP_MS = 1000;

  const attemptImage = (url: string, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const img = new Image();
      let timer = 0;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(ok);
      };
      img.onload = () => {
        // 等 CPU 解码完成；decode 本身不支持/失败时也视为可用
        const p = img.decode();
        if (p && typeof p.catch === "function") {
          p.then(() => finish(true)).catch(() => finish(true));
        } else {
          finish(true);
        }
      };
      img.onerror = () => finish(false);
      timer = window.setTimeout(() => {
        img.src = ""; // 中止可能挂起的 asset 请求
        finish(false);
      }, timeoutMs);
      img.src = url;
    });

  const updateImage = async (newUrl: string) => {
    if (!newUrl || newUrl === "none") return;

    let resolveLoad!: () => void;
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    currentImageLoadPromise = loadPromise;

    let loaded = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !loaded; attempt++) {
      // 期间已有更新的背景请求 / 组件卸载 → 放弃本次加载
      if (disposed || currentImageLoadPromise !== loadPromise) {
        resolveLoad();
        return;
      }
      loaded = await attemptImage(newUrl, LOAD_TIMEOUT_MS);
      if (
        !loaded &&
        !disposed &&
        currentImageLoadPromise === loadPromise &&
        attempt < MAX_ATTEMPTS
      ) {
        await new Promise((r) => setTimeout(r, RETRY_GAP_MS));
      }
    }

    if (disposed || currentImageLoadPromise !== loadPromise) {
      resolveLoad();
      return;
    }

    if (!loaded) {
      console.warn(
        `背景图片持续无法加载（已重试 ${MAX_ATTEMPTS} 次，可能仍在数据播种/文件尚未生成）: ${newUrl}`
      );
      resolveLoad();
      return;
    }

    // 确保只有最后一次触发的加载才会执行 DOM 更新
    if (currentImageLoadPromise === loadPromise) {
      // 如果上一个动画还没完就被打断，先整理状态
      if (isFadingIn.value) {
        currentImageUrl.value = nextImageUrl.value || currentImageUrl.value;
        isFadingIn.value = false;
      }

      // 2. 赋值新的背景图
      nextImageUrl.value = newUrl;

      // 3. 关键：等待 Vue 将 URL 更新到真实 DOM (style属性中)
      await nextTick();

      // 4. 关键：强制浏览器重排 (Reflow)
      if (topDivRef.value) {
        void topDivRef.value.offsetHeight;
      }

      // 5. 在下一帧安全地开启淡入动画
      requestAnimationFrame(() => {
        isFadingIn.value = true;
      });
    }

    resolveLoad();
  };

  const onTransitionEnd = () => {
    if (isFadingIn.value) {
      currentImageUrl.value = nextImageUrl.value;
      isFadingIn.value = false;
    }
  };

  const waitForLoad = () => currentImageLoadPromise || Promise.resolve();

  defineExpose({
    waitForLoad,
  });

  watch(
    () => props.src,
    (newUrl) => {
      updateImage(newUrl);
    },
    { immediate: true }
  );
</script>
