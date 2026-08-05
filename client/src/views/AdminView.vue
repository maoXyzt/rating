<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { NButton, NProgress, useDialog, useMessage, type DataTableColumns, type UploadCustomRequestOptions } from 'naive-ui';
import { useRouter } from 'vue-router';
import { createUploadId, imageApi } from '../services/images';
import type { SubjectItem } from '../types/image';

type AdminSubjectStatus = SubjectItem['status'] | 'uploading';
type AdminSubjectRow = Omit<SubjectItem, 'status'> & {
  status: AdminSubjectStatus;
  uploadId?: string;
  uploadProgress?: number;
  uploadError?: string | null;
};

const message = useMessage();
const dialog = useDialog();
const router = useRouter();
const serverSubjects = ref<SubjectItem[]>([]);
const uploadRows = ref<AdminSubjectRow[]>([]);
const loading = ref(false);
const importing = ref(false);

const tableRows = computed<AdminSubjectRow[]>(() => [...uploadRows.value, ...serverSubjects.value]);

function errorMessage(error: unknown) { return error instanceof Error ? error.message : '请求失败'; }
function statusLabel(status: AdminSubjectStatus) { return { uploading: '上传中', importing: '处理中', imported: '已完成', failed: '导入失败' }[status]; }
function stripZipName(filename: string) { return filename.replace(/\.zip$/i, '') || filename; }

function addUploadRow(uploadId: string, file: File) {
  const now = new Date().toISOString();
  uploadRows.value = [{
    _id: `upload-${uploadId}`,
    name: stripZipName(file.name),
    originalFilename: file.name,
    importBatch: uploadId,
    imageCount: 0,
    categoryCount: 0,
    status: 'uploading',
    createdAt: now,
    updatedAt: now,
    uploadId,
    uploadProgress: 0,
    uploadError: null
  }, ...uploadRows.value.filter(item => item.uploadId !== uploadId)];
}

function updateUploadRow(uploadId: string, patch: Partial<AdminSubjectRow>) {
  uploadRows.value = uploadRows.value.map(row => (row.uploadId === uploadId ? { ...row, ...patch } : row));
}

function removeUploadRow(uploadId: string) {
  uploadRows.value = uploadRows.value.filter(row => row.uploadId !== uploadId);
}

function upsertServerSubject(subject: SubjectItem) {
  serverSubjects.value = [subject, ...serverSubjects.value.filter(item => item._id !== subject._id)];
}

async function loadSubjects() {
  loading.value = true;
  try {
    serverSubjects.value = await imageApi.subjects();
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function importZip({ file, onFinish, onError }: UploadCustomRequestOptions) {
  if (!(file.file instanceof File)) {
    message.error('无法读取上传文件');
    onError();
    return;
  }

  const uploadId = createUploadId();
  addUploadRow(uploadId, file.file);
  importing.value = true;

  try {
    const result = await imageApi.importZip(file.file, {
      uploadId,
      onProgress: progress => updateUploadRow(uploadId, { uploadProgress: progress })
    });
    removeUploadRow(uploadId);
    upsertServerSubject(result.subject);
    message.success(`“${result.subject.name}”已导入 ${result.imported} 张图片`);
    onFinish();
  } catch (error) {
    const text = errorMessage(error);
    updateUploadRow(uploadId, { status: 'failed', uploadProgress: 100, uploadError: text });
    message.error(text);
    onError();
  } finally {
    importing.value = false;
  }
}

function deleteSubject(row: AdminSubjectRow) {
  if (row.status !== 'imported') return;
  dialog.warning({
    title: '删除图包',
    content: `确认删除“${row.name}”？图包内图片和评分记录也会一起删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const result = await imageApi.deleteSubject(row._id);
        message.success(`已删除“${row.name}”及 ${result.deletedImages} 张图片`);
        await loadSubjects();
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      }
    }
  });
}

function renderStatus(row: AdminSubjectRow) {
  if (row.status === 'uploading' || row.status === 'failed') {
    const percentage = Math.max(0, Math.min(100, row.uploadProgress ?? (row.status === 'failed' ? 100 : 0)));
    return h('div', { class: 'subject-status-cell' }, [
      h(NProgress, { percentage, showIndicator: false }),
      h('div', { class: ['subject-status-text', row.status === 'failed' ? 'is-error' : ''] }, row.status === 'uploading'
        ? `上传中 ${Math.round(percentage)}%`
        : row.uploadError || '上传失败')
    ]);
  }

  return h('span', { class: row.status === 'imported' ? 'subject-status-done' : 'subject-status-muted' }, statusLabel(row.status));
}

onMounted(() => void loadSubjects());

const columns: DataTableColumns<AdminSubjectRow> = [
  { title: 'ZIP', key: 'name', minWidth: 180 },
  { title: '源文件', key: 'originalFilename', minWidth: 220 },
  { title: '图片数', key: 'imageCount', width: 90 },
  { title: '目录数', key: 'categoryCount', width: 90 },
  { title: '状态', key: 'status', width: 180, render: row => renderStatus(row) },
  { title: '导入时间', key: 'createdAt', width: 180, render: row => new Date(row.createdAt).toLocaleString() },
  {
    title: '功能',
    key: 'actions',
    width: 180,
    fixed: 'right',
    render: row => h('div', { class: 'table-actions' }, [
      h(NButton, {
        size: 'small',
        secondary: true,
        disabled: row.status !== 'imported',
        onClick: () => {
          if (row.status !== 'imported') return;
          router.push(`/admin/subjects/${encodeURIComponent(row._id)}`);
        }
      }, { default: () => '查看图片' }),
      h(NButton, {
        size: 'small',
        tertiary: true,
        type: 'error',
        disabled: row.status !== 'imported',
        onClick: () => deleteSubject(row)
      }, { default: () => '删除' })
    ])
  }
];
</script>

<template>
  <n-layout class="main">
    <n-layout-content class="content admin-content">
      <div class="table-shell">
        <div class="table-shell-header">
          <div class="table-shell-header-flex">
            <strong>图包列表</strong>
            <n-text depth="3">共 {{ tableRows.length }} 个图包</n-text>
          </div>
          <n-upload class="table-shell-header-upload" accept=".zip,application/zip" :show-file-list="false"
            :disabled="importing" :custom-request="importZip">
            <n-button type="primary" :loading="importing">上传 ZIP</n-button>
          </n-upload>
        </div>
        <n-data-table v-if="tableRows.length" :columns="columns" :data="tableRows" :loading="loading" :bordered="false"
          :scroll-x="960" />
        <div v-else class="empty">{{ loading ? '正在加载...' : '暂无图片包，请上传 ZIP 文件' }}</div>
      </div>
    </n-layout-content>
  </n-layout>
</template>
