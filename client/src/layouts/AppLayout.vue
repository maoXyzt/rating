<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  cancelScorerName,
  openScorerPrompt,
  scorerName,
  scorerPromptError,
  scorerPromptValue,
  scorerPromptVisible,
  submitScorerName
} from '../composables/scorer';

const router = useRouter();
const route = useRoute();

const currentPageLabel = computed(() => (route.path.startsWith('/admin') ? '管理' : '打分'));

const userMenuOptions = computed(() => [
  {
    label: scorerName.value ? `打分人：${scorerName.value}` : '打分人：未填写',
    key: 'scorer-name',
    disabled: true
  },
  { type: 'divider', key: 'divider' },
  { label: '打分页面', key: 'rating' },
  { label: '管理页面', key: 'admin' },
  { label: scorerName.value ? '修改打分人' : '填写打分人', key: 'edit' }
]);

function handleMenuSelect(key: string | number) {
  if (key === 'rating') {
    void router.push('/');
    return;
  }
  if (key === 'admin') {
    void router.push('/admin');
    return;
  }
  if (key === 'edit') {
    void openScorerPrompt();
  }
}

function handlePromptUpdateShow(value: boolean) {
  if (!value) cancelScorerName();
}
</script>

<template>
  <n-config-provider>
    <n-message-provider>
      <n-dialog-provider>
        <n-layout class="app">
          <n-layout-header bordered class="header">
            <strong>打分平台</strong>
            <div class="header-actions">
              <n-dropdown trigger="hover" placement="bottom-end" :options="userMenuOptions" @select="handleMenuSelect">
                <n-button quaternary circle class="user-menu-button" aria-label="用户菜单" :title="`当前页面：${currentPageLabel}`">
                  <svg class="user-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M12 12c2.761 0 5-2.239 5-5s-2.239-5-5-5-5 2.239-5 5 2.239 5 5 5zm0 2c-4.418 0-8 2.239-8 5v1h16v-1c0-2.761-3.582-5-8-5z"
                      fill="currentColor"
                    />
                  </svg>
                </n-button>
              </n-dropdown>
            </div>
          </n-layout-header>
          <router-view />
        </n-layout>
      </n-dialog-provider>
      <n-modal
        :show="scorerPromptVisible"
        preset="dialog"
        title="填写打分人"
        positive-text="保存"
        negative-text="取消"
        :show-icon="false"
        @positive-click="submitScorerName"
        @negative-click="cancelScorerName"
        @update:show="handlePromptUpdateShow"
      >
        <n-space vertical class="scorer-prompt-body">
          <n-text depth="3">请输入你的名字，之后会自动保存在当前浏览器。</n-text>
          <n-input
            v-model:value="scorerPromptValue"
            autofocus
            maxlength="100"
            placeholder="例如：张三"
            @keyup.enter="submitScorerName"
          />
          <n-text v-if="scorerPromptError" class="scorer-prompt-error">{{ scorerPromptError }}</n-text>
        </n-space>
      </n-modal>
    </n-message-provider>
  </n-config-provider>
</template>
