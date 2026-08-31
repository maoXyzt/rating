<script setup lang="ts">
withDefaults(defineProps<{
  state: 'loading' | 'stale' | 'unavailable';
  title?: string;
  description?: string;
  retryLabel?: string;
  retrying?: boolean;
}>(), {
  title: '暂时无法加载内容',
  description: '当前查询人数较多，内容还没有准备好',
  retryLabel: '重新加载',
  retrying: false
});

defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="state !== 'stale'" class="async-state-placeholder" :class="`is-${state}`" role="status" aria-live="polite">
    <div v-if="state === 'loading'" class="async-state-placeholder-spinner" aria-hidden="true"></div>
    <div v-else class="async-state-placeholder-icon" aria-hidden="true">⋯</div>
    <strong>{{ state === 'loading' ? '正在加载' : title }}</strong>
    <span>{{ state === 'loading' ? '请稍候' : description }}</span>
    <button v-if="state === 'unavailable'" type="button" :disabled="retrying" @click="$emit('retry')">
      {{ retrying ? '正在重试…' : retryLabel }}
    </button>
  </div>
  <div v-else class="async-state-stale" role="status" aria-live="polite">
    <span>{{ description }}</span>
    <button type="button" :disabled="retrying" @click="$emit('retry')">
      {{ retrying ? '正在重试…' : retryLabel }}
    </button>
  </div>
</template>
