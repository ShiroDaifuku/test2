<template>
  <div class="relative h-full w-full">
    <!-- 底层图片（当前显示） -->
    <slot></slot>
    <img
      v-if="currentImageUrl"
      class="absolute inset-0 z-10 h-full w-full select-none"
      :style="makeStyle()"
      :src="currentImageUrl"
      alt=""
      draggable="false"
    />

    <!-- 顶层图片（准备淡入的新图片）。
         用 <img> 而不是 CSS background-image：
         iOS WKWebView 对自定义 scheme（asset://…）的 CSS url() 不一定触发 scheme handler，
         导致背景永远空白；而角色立绘用 <img> 走同一 scheme 已实测正常。 -->
    <img
      ref="topDivRef"
      class="absolute inset-0 z-20 h-full w-full select-none transition-opacity ease-in-out"
      :class="isFadingIn ? 'opacity-100' : 'opacity-0'"
      :style="makeStyle({ transitionDuration: `${duration}ms` })"
      :src="nextImageUrl || undefined"
      alt=""
      draggable="false"
      @transitionend="onTransitionEnd"
    />
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

  const topDivRef = ref<HTMLElement | null>(null); // 顶层 <img> 的引用（用于强制重排）
  const currentImageUrl = ref("");
  const nextImageUrl = ref("");
  const isFadingIn = ref(false);

  /** 组装 <img> 的 object-fit / object-position 内联样式（返回 any 以通过模板类型检查） */
  const makeStyle = (extra?: Record<string, string>): any => ({
    objectFit: props.objectFit,
    objectPosition: props.position,
    ...(extra || {}),
  });

  let currentImageLoadPromise: Promise<void> | null = null;

  const updateImage = async (newUrl: string) => {
    if (!newUrl || newUrl === "none") return;

    let resolveLoad!: () => void;
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    currentImageLoadPromise = loadPromise;

    // 预加载：加载成功才淡入，失败不覆盖当前图（避免 <img> 显示破图）
    let loaded = false;
    const img = new Image();
    const imgReadyPromise = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (err) => reject(err);
    });
    img.src = newUrl;

    try {
      await imgReadyPromise;
      await img.decode().catch(() => {});
      loaded = true;
    } catch (err) {
      console.error(`加载图片失败: ${newUrl}`, err);
    }

    if (!loaded) {
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

      // 赋值新图
      nextImageUrl.value = newUrl;

      // 等待 Vue 更新 DOM
      await nextTick();

      // 强制浏览器重排 (Reflow)
      if (topDivRef.value) {
        void topDivRef.value.offsetHeight;
      }

      // 下一帧开启淡入
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
