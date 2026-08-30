<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { NButton, NTag } from 'naive-ui';

const props = withDefaults(defineProps<{
  modelValue: string[];
  placeholder?: string;
  disabled?: boolean;
}>(), {
  placeholder: '粘贴或输入打分人姓名，空格、换行、逗号可分隔',
  disabled: false
});

const emit = defineEmits<{
  'update:modelValue': [value: string[]];
}>();

const draft = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const count = computed(() => props.modelValue.length);

function focusInput() {
  if (!props.disabled) inputRef.value?.focus();
}

function addNames(value: string) {
  const names = value
    .split(/[\s,，;；、]+/)
    .map(item => item.trim())
    .filter(Boolean);
  if (!names.length) return;

  const existing = new Set(props.modelValue);
  const merged = [...props.modelValue];
  for (const name of names) {
    if (existing.has(name)) continue;
    existing.add(name);
    merged.push(name);
  }
  emit('update:modelValue', merged);
  draft.value = '';
}

function commitDraft() {
  if (!draft.value.trim()) return;
  addNames(draft.value);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Backspace' && !draft.value && props.modelValue.length) {
    emit('update:modelValue', props.modelValue.slice(0, -1));
    return;
  }
  if (['Enter', 'Tab', ' ', ',', '，', ';', '；', '、'].includes(event.key)) {
    if (!draft.value.trim()) return;
    event.preventDefault();
    addNames(draft.value);
  }
}

function handlePaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text') || '';
  if (!text) return;
  event.preventDefault();
  addNames(text);
}

function removeName(name: string) {
  const index = props.modelValue.indexOf(name);
  if (index < 0) return;
  const next = props.modelValue.slice();
  next.splice(index, 1);
  emit('update:modelValue', next);
}

function clearNames() {
  emit('update:modelValue', []);
  draft.value = '';
  void nextTick(focusInput);
}
</script>

<template>
  <div class="bulk-name-editor" :class="{ 'is-disabled': disabled }" @click="focusInput">
    <div v-if="modelValue.length" class="bulk-name-editor-tags">
      <n-tag
        v-for="name in modelValue"
        :key="name"
        size="small"
        closable
        :disabled="disabled"
        @close.stop="removeName(name)"
      >
        {{ name }}
      </n-tag>
    </div>
    <input
      ref="inputRef"
      v-model="draft"
      class="bulk-name-editor-input"
      :disabled="disabled"
      :placeholder="modelValue.length ? '继续输入或粘贴姓名' : placeholder"
      @blur="commitDraft"
      @keydown="handleKeydown"
      @paste="handlePaste"
    >
    <div class="bulk-name-editor-footer">
      <span>已解析 {{ count }} 个打分人</span>
      <n-button v-if="count" text size="tiny" :disabled="disabled" @click.stop="clearNames">
        清空
      </n-button>
    </div>
  </div>
</template>
