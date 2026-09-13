<template>
  <Transition name="modal">
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      @click="handleClose"
    >
      <div
        class="flex h-[85dvh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border
          border-white/20
          bg-[linear-gradient(135deg,rgba(255,255,255,0.15)_0%,rgba(255,255,255,0.05)_100%)]
          text-white shadow-[0_20px_60px_rgba(0,0,0,0.4),inset_0_0_1px_rgba(255,255,255,0.3)]
          backdrop-blur-[30px] backdrop-saturate-180"
        @click.stop
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between border-b border-white/10
            bg-[linear-gradient(180deg,rgba(255,255,255,0.1)_0%,rgba(255,255,255,0.05)_100%)] p-6"
        >
          <div class="flex items-center gap-4">
            <div
              class="flex h-12 w-12 items-center justify-center rounded-xl bg-white/10 shadow-inner"
            >
              <Icon icon="setting" />
            </div>
            <div>
              <h2 class="m-0 text-xl font-bold drop-shadow-[0_2px_4px_rgba(0,0,0,0.3)]">
                {{ $t("settings.characterInfo.header.title", { title }) }}
              </h2>
              <p class="m-0 text-sm text-white/50">
                {{ $t("settings.characterInfo.header.subtitle") }}
              </p>
            </div>
          </div>
          <button
            class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-none
              bg-white/10 text-white transition-all duration-200 hover:rotate-90 hover:bg-white/20"
            @click="handleClose"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div class="flex flex-1 flex-row overflow-hidden">
          <!-- Sidebar (vertical scrollable for narrow viewports) -->
          <div
            class="tab-sidebar-scroll flex w-44 shrink-0 flex-col gap-2 overflow-y-auto border-r
              border-white/10 bg-black/10 p-3"
          >
            <button
              v-for="tab in tabs"
              :key="tab.id"
              class="w-full cursor-pointer rounded-xl border-none bg-transparent px-4 py-2.5
                text-left font-medium text-white/60 transition-all duration-200 hover:bg-white/5
                hover:text-white"
              :class="{
                'bg-[rgba(94,114,228,0.2)] font-semibold! text-[#79d9ff]!': activeTab === tab.id,
              }"
              @click="activeTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </div>

          <!-- Tab Panels -->
          <div class="relative flex-1 overflow-y-auto p-6">
            <div v-if="loading" class="flex h-full items-center justify-center">
              <div
                class="h-10 w-10 animate-spin rounded-full border-3 border-white/10
                  border-t-[#5e72e4]"
              ></div>
            </div>

            <div v-else class="mx-auto max-w-3xl space-y-6">
              <!-- Data-Driven Form (tabs with schemas) -->
              <div v-if="currentTabConfig" class="space-y-4">
                <div
                  v-for="(field, index) in currentTabFields"
                  :key="index"
                  class="flex flex-col gap-2"
                >
                  <label :for="field.key" class="text-[13px] font-medium text-white/60"
                    >{{ field.label }} ({{ field.key }})</label
                  >
                  <input
                    v-if="field.type === 'text' || field.type === 'number'"
                    :id="field.key"
                    v-model="fieldModel(field).value"
                    :type="field.type"
                    :step="field.step"
                    :placeholder="field.placeholder"
                    class="form-control rounded-xl border border-white/10 bg-black/20 px-3.5 py-2.5
                      text-sm text-white transition-all duration-200 outline-none"
                    @change="handleFieldChange(field)"
                  />
                  <textarea
                    v-else-if="field.type === 'textarea'"
                    :id="field.key"
                    v-model="fieldModel(field).value"
                    :rows="field.rows || 4"
                    class="form-control rounded-xl border border-white/10 bg-black/20 px-3.5 py-2.5
                      font-mono text-sm leading-relaxed text-white transition-all duration-200
                      outline-none"
                  ></textarea>
                  <select
                    v-else-if="field.type === 'select'"
                    :id="field.key"
                    v-model="fieldModel(field).value"
                    class="form-control rounded-xl border border-white/10 bg-black/20 px-3.5 py-2.5
                      text-sm text-white transition-all duration-200 outline-none"
                    @change="handleFieldChange(field)"
                  >
                    <option
                      v-for="opt in resolveFieldOptions(field)"
                      :key="opt.value"
                      :value="opt.value"
                      class="bg-[#333] text-white"
                    >
                      {{ opt.label }}
                    </option>
                  </select>
                </div>
              </div>

              <!-- Clothes Tab (custom UI, outside data-driven block) -->
              <div v-if="activeTab === 'clothes'" class="space-y-4">
                <div class="flex items-center justify-between">
                  <h3 class="text-sm font-bold text-white/70">
                    {{ $t("settings.characterInfo.clothes.listTitle") }}
                  </h3>
                  <button
                    class="cursor-pointer rounded-lg border-none bg-[#5e72e4] px-3 py-1.5 text-xs
                      text-white transition-colors hover:bg-[#4a5acf]"
                    @click="addClothesItem"
                  >
                    + {{ $t("settings.characterInfo.clothes.add") }}
                  </button>
                </div>
                <div
                  v-for="(item, idx) in clothesList"
                  :key="idx"
                  class="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4"
                >
                  <div class="flex items-center justify-between">
                    <span class="text-sm font-medium text-white/80">{{
                      $t("settings.characterInfo.clothes.item", { index: idx + 1 })
                    }}</span>
                    <button
                      class="h-6 w-6 cursor-pointer rounded-full border-none bg-red-500/20 text-xs
                        text-red-400 transition-colors hover:bg-red-500/40"
                      @click="removeClothesItem(idx)"
                    >
                      x
                    </button>
                  </div>
                  <div class="flex flex-col gap-2">
                    <label class="text-[13px] font-medium text-white/60">name</label>
                    <input
                      v-model="item.name"
                      type="text"
                      class="form-control rounded-xl border border-white/10 bg-black/20 px-3.5
                        py-2.5 text-sm text-white transition-all duration-200 outline-none"
                    />
                  </div>
                  <div class="flex flex-col gap-2">
                    <label class="text-[13px] font-medium text-white/60">prompt</label>
                    <textarea
                      v-model="item.prompt"
                      rows="3"
                      class="form-control rounded-xl border border-white/10 bg-black/20 px-3.5
                        py-2.5 font-mono text-sm leading-relaxed text-white transition-all
                        duration-200 outline-none"
                    ></textarea>
                  </div>
                </div>
                <div v-if="clothesList.length === 0" class="py-8 text-center text-sm text-white/40">
                  {{ $t("settings.characterInfo.clothes.empty") }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div
          class="flex justify-between gap-3 border-t border-white/10
            bg-[linear-gradient(180deg,rgba(255,255,255,0.05)_0%,rgba(255,255,255,0.1)_100%)] p-4"
        >
          <!-- 危险操作区（左侧）：删除角色 -->
          <div class="flex items-center">
            <button
              :disabled="deleteState.disabled"
              :title="
                deleteState.disabled
                  ? deleteState.reason
                  : t('settings.characterInfo.delete.button')
              "
              :class="[
                'rounded-[20px] border px-4 py-2 text-sm font-medium transition-all duration-200',
                deleteState.disabled
                  ? 'cursor-not-allowed border-white/10 bg-white/5 text-white/25'
                  : `border-red-400/30 bg-red-500/15 text-red-200 hover:-translate-y-px
                    hover:bg-red-500/30 hover:shadow-[0_4px_12px_rgba(239,68,68,0.3)]`,
              ]"
              @click="deleteState.disabled ? null : handleDelete()"
            >
              <span class="inline-flex items-center gap-1.5">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path
                    d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
                  ></path>
                  <line x1="10" y1="11" x2="10" y2="17"></line>
                  <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
                {{ t("settings.characterInfo.delete.button") }}
              </span>
            </button>
          </div>

          <!-- 普通操作（右侧）：取消/保存 -->
          <div class="flex gap-3">
            <button
              class="cursor-pointer rounded-[20px] border-none bg-white/10 px-5 py-2 text-sm
                font-medium text-white transition-all duration-200 hover:bg-white/20"
              @click="handleClose"
            >
              {{ $t("settings.characterInfo.footer.cancel") }}
            </button>
            <button
              class="cursor-pointer rounded-[20px] border-none bg-[#5e72e4] px-5 py-2 text-sm
                font-medium text-white transition-all duration-200 hover:enabled:-translate-y-px
                hover:enabled:bg-[#4a5acf] hover:enabled:shadow-[0_4px_12px_rgba(94,114,228,0.3)]
                disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="saving"
              @click="saveSettings"
            >
              <span
                v-if="saving"
                class="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2
                  border-white/30 border-t-white"
              ></span>
              {{
                saving
                  ? $t("settings.characterInfo.footer.saving")
                  : $t("settings.characterInfo.footer.save")
              }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
  import { computed, onUnmounted, ref, watch } from "vue";
  import { useI18n } from "vue-i18n";
  import {
    deleteCharacter as deleteCharacterApi,
    getRoleSettings,
    updateRoleSettings,
  } from "../../../api/services/character";
  import { Icon } from "../../base";
  import { isSystemProtectedRole } from "@/constants/character";
  import { useDialogStore } from "../../../stores/modules/ui/dialog";
  import { useGameStore } from "@/stores/modules/game";
  import { useUIStore } from "@/stores/modules/ui/ui";

  const props = defineProps<{
    visible: boolean;
    roleId: number | null;
    title?: string;
    /** 来源："game" 或提供该角色的插件 id（插件角色不可直接删除）。 */
    source?: string | null;
  }>();

  const emit = defineEmits(["close", "saved"]);

  const activeTab = ref("basic");
  const loading = ref(false);
  const saving = ref(false);
  const deleting = ref(false);
  const dialogStore = useDialogStore();
  const { t } = useI18n();
  const uiStore = useUIStore();
  const gameStore = useGameStore();
  const localSettings = ref<any>({});

  // 删除按钮可用性：系统保护角色 / 在场角色不可删
  const deleteState = computed(() => {
    if (!props.roleId)
      return { disabled: true, reason: t("settings.characterInfo.delete.systemProtected") };
    if (isSystemProtectedRole(props.roleId)) {
      return { disabled: true, reason: t("settings.characterInfo.delete.systemProtected") };
    }
    const onstage =
      gameStore.mainRoleId === props.roleId || gameStore.presentRoleIds.includes(props.roleId);
    if (onstage) {
      return { disabled: true, reason: t("settings.characterInfo.delete.onstage") };
    }
    return { disabled: false, reason: "" };
  });

  // 单次 confirm，三件全删（DB + 存档 + 记忆 + 物理文件），避免二次 confirm 三态歧义
  const handleDelete = async () => {
    if (!props.roleId || deleteState.value.disabled) return;

    // 插件角色不可直接删除：提示去插件设置里隐藏
    if (props.source && props.source !== "game") {
      await dialogStore.alert(t("settings.characterInfo.delete.pluginFromPlugin"));
      return;
    }

    const confirmed = await dialogStore.confirm(
      t("settings.characterInfo.delete.confirmMessage", {
        title: props.title ?? t("settings.characterInfo.delete.button"),
      }),
      t("settings.characterInfo.delete.confirmTitle")
    );
    if (!confirmed) return;

    deleting.value = true;
    try {
      await deleteCharacterApi(props.roleId, true);

      // 删除成功
      uiStore.showSuccess({
        title: t("settings.characterInfo.delete.successTitle"),
        message: t("settings.characterInfo.delete.successMessage", {
          title: props.title ?? t("settings.characterInfo.delete.button"),
        }),
      });

      // 通知父组件刷新列表 + 关闭弹窗
      emit("saved");
      emit("close");
    } catch (error: any) {
      console.error("[SettingsCharacterInfo] 删除角色失败:", error);
      uiStore.showError({
        title: t("settings.characterInfo.delete.failTitle"),
        message: typeof error === "string" ? error : error?.message || "未知错误",
      });
    } finally {
      deleting.value = false;
    }
  };

  const tabs = computed(() => [
    { id: "basic", label: t("settings.characterInfo.tabs.basic") },
    { id: "prompts", label: t("settings.characterInfo.tabs.prompts") },
    { id: "visuals", label: t("settings.characterInfo.tabs.visuals") },
    { id: "clothes", label: t("settings.characterInfo.tabs.clothes") },
    { id: "pet", label: t("settings.characterInfo.tabs.pet") },
  ]);

  // --- Schema Definition ---

  type FieldType = "text" | "number" | "textarea" | "select";

  interface FieldOption {
    label: string;
    value: string;
    visibleIf?: (settings: any) => boolean;
  }

  interface FieldSchema {
    key: string;
    label: string;
    type: FieldType;
    rows?: number;
    step?: string;
    placeholder?: string;
    options?: FieldOption[];
    // Dynamic options computed from refs/state. Overrides options when set.
    dynamicOptions?: () => { label: string; value: string }[];
    visibleIf?: (settings: any) => boolean;
    realtime?: boolean;
    // When set, the field reads/writes into localSettings.value[parent][key].
    // The parent object is auto-initialised to {} on first write if missing.
    parent?: string;
  }

  const resolveFieldOptions = (field: FieldSchema) => {
    const options: FieldOption[] = field.dynamicOptions
      ? field.dynamicOptions()
      : (field.options ?? []);
    return options.filter((option) => !option.visibleIf || option.visibleIf(localSettings.value));
  };

  const schemas = computed<Record<string, FieldSchema[]>>(() => ({
    basic: [
      { key: "ai_name", label: t("settings.characterInfo.fields.aiName"), type: "text" },
      { key: "ai_subtitle", label: t("settings.characterInfo.fields.aiSubtitle"), type: "text" },
      { key: "user_name", label: t("settings.characterInfo.fields.userName"), type: "text" },
      {
        key: "user_subtitle",
        label: t("settings.characterInfo.fields.userSubtitle"),
        type: "text",
      },
      { key: "title", label: t("settings.characterInfo.fields.title"), type: "text" },
      { key: "info", label: t("settings.characterInfo.fields.info"), type: "textarea", rows: 4 },
    ],
    prompts: [
      {
        key: "system_prompt",
        label: t("settings.characterInfo.fields.systemPrompt"),
        type: "textarea",
        rows: 10,
      },
      {
        key: "system_prompt_example",
        label: t("settings.characterInfo.fields.systemPromptExample"),
        type: "textarea",
        rows: 6,
      },
      {
        key: "system_prompt_example_old",
        label: t("settings.characterInfo.fields.systemPromptExampleOld"),
        type: "textarea",
        rows: 4,
      },
    ],
    visuals: [
      {
        key: "scale",
        label: t("settings.characterInfo.fields.scale"),
        type: "number",
        step: "0.01",
      },
      {
        key: "offset_x",
        label: t("settings.characterInfo.fields.offsetX"),
        type: "number",
        step: "0.1",
      },
      {
        key: "offset_y",
        label: t("settings.characterInfo.fields.offsetY"),
        type: "number",
        step: "0.1",
      },
      { key: "bubble_top", label: t("settings.characterInfo.fields.bubbleTop"), type: "number" },
      { key: "bubble_left", label: t("settings.characterInfo.fields.bubbleLeft"), type: "number" },
      {
        key: "thinking_message",
        label: t("settings.characterInfo.fields.thinkingMessage"),
        type: "text",
      },
    ],
    pet: [
      {
        key: "scale_p",
        label: t("settings.characterInfo.fields.scaleP"),
        type: "number",
        step: "0.01",
      },
      {
        key: "offset_x_p",
        label: t("settings.characterInfo.fields.offsetXP"),
        type: "number",
        step: "0.1",
      },
      {
        key: "offset_y_p",
        label: t("settings.characterInfo.fields.offsetYP"),
        type: "number",
        step: "0.1",
      },
    ],
  }));

  // --- Computed Properties ---

  const currentTabConfig = computed(() => schemas.value[activeTab.value]);

  // voice model 子区域已移除，所有字段统一在主表单渲染
  const currentTabFields = computed(() => {
    const fields = currentTabConfig.value || [];
    // 过滤掉当前不可见的字段（visibleIf 为 false），避免留下空 div 占位
    return fields.filter((field) => !field.visibleIf || field.visibleIf(localSettings.value));
  });

  const fieldModel = (field: FieldSchema) => {
    return computed({
      get: () => {
        let target: any;
        if (field.parent) {
          const parentObj = localSettings.value[field.parent];
          target =
            parentObj && typeof parentObj === "object"
              ? parentObj
              : (localSettings.value[field.parent] = {});
        } else {
          target = localSettings.value;
        }
        return target[field.key];
      },
      set: (val: any) => {
        const coerced = field.type === "number" ? Number(val) : val;
        let target: any;
        if (field.parent) {
          if (
            !localSettings.value[field.parent] ||
            typeof localSettings.value[field.parent] !== "object"
          ) {
            localSettings.value[field.parent] = {};
          }
          target = localSettings.value[field.parent];
        } else {
          target = localSettings.value;
        }
        target[field.key] = coerced;
      },
    });
  };

  const clothesList = computed({
    get: () => {
      if (!Array.isArray(localSettings.value.clothes)) {
        localSettings.value.clothes = [];
      }
      return localSettings.value.clothes as Array<{ name: string; prompt: string }>;
    },
    set: (val) => {
      localSettings.value.clothes = val;
    },
  });

  const addClothesItem = () => {
    if (!Array.isArray(localSettings.value.clothes)) {
      localSettings.value.clothes = [];
    }
    localSettings.value.clothes.push({ name: "", prompt: "" });
  };

  const removeClothesItem = (idx: number) => {
    if (Array.isArray(localSettings.value.clothes)) {
      localSettings.value.clothes.splice(idx, 1);
    }
  };

  // --- Watchers & Methods ---

  watch(
    () => props.visible,
    async (newVal) => {
      if (!newVal) {
        clearRealtimeSaveTimer();
      }
      if (newVal && props.roleId) {
        loading.value = true;
        try {
          const data = await getRoleSettings(props.roleId);
          localSettings.value = JSON.parse(JSON.stringify(data));
        } catch (e) {
          console.error("Failed to load character settings", e);
          emit("close");
        } finally {
          loading.value = false;
        }
      }
    }
  );

  const REALTIME_SAVE_DEBOUNCE_MS = 300;
  let realtimeSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRealtimeSaveTimer = () => {
    if (realtimeSaveTimer !== null) {
      clearTimeout(realtimeSaveTimer);
      realtimeSaveTimer = null;
    }
  };

  const handleClose = () => {
    clearRealtimeSaveTimer();
    emit("close");
  };

  const handleFieldChange = (field: FieldSchema) => {
    if (!field.realtime || !props.roleId) return;

    // 防抖逻辑
    const roleId = props.roleId;
    clearRealtimeSaveTimer();
    realtimeSaveTimer = setTimeout(async () => {
      realtimeSaveTimer = null;
      if (!props.visible || props.roleId !== roleId) return;
      try {
        await updateRoleSettings(roleId, localSettings.value);
      } catch (e) {
        console.error(`实时更新 ${field.key} 失败:`, e);
        // 使用国际化
        await dialogStore.alert(
          t("settings.characterInfo.messages.realtimeUpdateFailed", { label: field.label })
        );
      }
    }, REALTIME_SAVE_DEBOUNCE_MS);
  };

  const saveSettings = async () => {
    if (!props.roleId) return;
    clearRealtimeSaveTimer();
    saving.value = true;
    try {
      await updateRoleSettings(props.roleId, localSettings.value);
      emit("saved");
      emit("close");
    } catch (e) {
      console.error("Failed to save settings", e);
      await dialogStore.alert(t("settings.characterInfo.messages.saveFailed"));
    } finally {
      saving.value = false;
    }
  };

  onUnmounted(clearRealtimeSaveTimer);
</script>

<style scoped>
  /* 表单控件 :focus 选中状态 */
  /* Vertical sidebar: thin custom scrollbar (Webkit + Firefox). */
  .tab-sidebar-scroll {
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
  }
  .tab-sidebar-scroll::-webkit-scrollbar {
    width: 6px;
  }
  .tab-sidebar-scroll::-webkit-scrollbar-track {
    background: transparent;
  }
  .tab-sidebar-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.18);
    border-radius: 3px;
  }
  .tab-sidebar-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.32);
  }

  .form-control:focus {
    border-color: #79d9ff;
    background: rgba(0, 0, 0, 0.3);
    box-shadow: 0 0 0 3px rgba(121, 217, 255, 0.2);
  }
</style>
