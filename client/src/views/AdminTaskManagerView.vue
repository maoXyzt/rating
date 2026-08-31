<script setup lang="ts">
import { h, onMounted, ref } from 'vue';
import { NButton, NTag, useMessage, type DataTableColumns } from 'naive-ui';
import { useRouter } from 'vue-router';
import { imageApi } from '../services/images';
import type { ProjectItem } from '../types/image';
import { formatDateTime } from '../utils/time';

const router = useRouter();
const message = useMessage();
const loading = ref(false);
const subjects = ref<ProjectItem[]>([]);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function taskStatusLabel(status: ProjectItem['taskStatus']) {
  return {
    task_pending: '任务未开始',
    scoring: '打分中',
    task_completed: '打分任务已完成'
  }[status] || '任务未开始';
}

function taskStatusType(status: ProjectItem['taskStatus']) {
  if (status === 'task_completed') return 'success';
  if (status === 'scoring') return 'warning';
  return 'default';
}

async function loadSubjects() {
  loading.value = true;
  try {
    subjects.value = await imageApi.projects();
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

const columns: DataTableColumns<ProjectItem> = [
  { title: '项目', key: 'name', minWidth: 180 },
  { title: '图片数', key: 'imageCount', width: 90 },
  { title: '目录数', key: 'categoryCount', width: 90 },
  {
    title: '任务状态',
    key: 'taskStatus',
    width: 150,
    render: row => h(NTag, { size: 'small', type: taskStatusType(row.taskStatus) }, {
      default: () => taskStatusLabel(row.taskStatus)
    })
  },
  { title: '更新时间', key: 'updatedAt', width: 180, render: row => formatDateTime(row.updatedAt) },
  {
    title: '操作',
    key: 'actions',
    width: 120,
    fixed: 'right',
    render: row => h(NButton, {
      size: 'small',
      secondary: true,
      disabled: row.taskStatus === 'task_pending',
      onClick: () => router.push(`/admin/projects/${encodeURIComponent(row._id)}/tasks`)
    }, { default: () => '查看任务' })
  }
];

onMounted(() => void loadSubjects());
</script>

<template>
  <div class="admin-page">


    <div class="table-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>任务概览</strong>
          <n-text depth="3">共 {{ subjects.length }} 个项目</n-text>
        </div>
      </div>
      <n-data-table v-if="subjects.length" :columns="columns" :data="subjects" :loading="loading" :bordered="false"
        :scroll-x="820" />
      <div v-else class="empty">{{ loading ? '正在加载...' : '暂无任务数据' }}</div>
    </div>
  </div>
</template>
