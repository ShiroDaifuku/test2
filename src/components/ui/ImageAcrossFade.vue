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
  import { ref, watch, nextTick } from "vue";

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

  // 资源未就绪（首启数据播种/慢网络）时自动限次重试：目标出现后随时间自动载入切换，
  // 期间保留上一张背景不黑屏。
  const MAX_LOAD_RETRIES = 12; // 每次间隔 1.2s，共约 15s 窗口
  const loadWithRetry = async (url: string, attemptsLeft: number): Promise<void> => {
    const img = new Image();
    const ready = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`图片加载失败: ${url}`));
    });
    img.src = url;
    try {
      await ready;
      // 等 CPU 解码完成 (忽略 decode 本身不支持时的报错)
      await img.decode().catch(() => {});
    } catch (err) {
      if (attemptsLeft <= 0) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return loadWithRetry(url, attemptsLeft - 1);
    }
  };

  const updateImage = async (newUrl: string) => {
    if (!newUrl || newUrl === "none") return;

    let resolveLoad!: () => void;
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    currentImageLoadPromise = loadPromise;

    try {
      await loadWithRetry(newUrl, MAX_LOAD_RETRIES);
    } catch (err) {
      console.error(`背景图片加载失败（已重试 ${MAX_LOAD_RETRIES} 次）: ${newUrl}`, err);
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
