<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NTag, useDialog, useMessage, type DataTableColumns, type UploadFileInfo } from 'naive-ui';
import { taskCriteria, type TaskCriterionKey } from '../constants/scoreCriteria';
import { authApi } from '../services/auth';
import { imageApi } from '../services/images';
import { useTaskStackStore } from '../stores/taskStack';
import type {
  ProjectItem,
  ScoringManagementSummary,
  ScoringRollbackPreview,
  ScoringSummaryScorer,
  ScoringTaskRecord,
  TaskSubmissionModeFilter
} from '../types/image';

const message = useMessage();
const dialog = useDialog();
const taskStack = useTaskStackStore();
const loading = ref(false);
const detailLoading = ref(false);
const previewing = ref(false);
const rollbackSubmitting = ref(false);
const projects = ref<ProjectItem[]>([]);
const scorerOptions = ref<Array<{ label: string; value: string }>>([]);
const scorersLoading = ref(false);
const summary = ref<ScoringManagementSummary | null>(null);
const detailVisible = ref(false);
const detailScorer = ref<ScoringSummaryScorer | null>(null);
const detailRecords = ref<ScoringTaskRecord[]>([]);
const detailTotal = ref(0);
const detailPage = ref(1);
const detailPageSize = ref(20);
const scorerPage = ref(1);
const scorerPageSize = ref(10);
const rollbackVisible = ref(false);
const rollbackPreview = ref<ScoringRollbackPreview | null>(null);
const rollbackFileName = ref('');

const filters = reactive({
  scorer: null as string | null,
  projectId: null as string | null,
  submissionMode: null as TaskSubmissionModeFilter | null
});

const submissionModeOptions = [
  { label: '疑似直接提交', value: 'direct' },
  { label: '已操作排序', value: 'ranked' },
  { label: '未记录', value: 'untracked' }
];

const projectOptions = computed(() => projects.value.map(project => ({
  label: project.name,
  value: project._id
})));

const hasFilters = computed(() => Boolean(filters.scorer || filters.projectId || filters.submissionMode));

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatPercent(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '-';
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} 分 ${rest} 秒`;
}

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : '-';
}

function criterionLabel(key: TaskCriterionKey | null | undefined) {
  return taskCriteria.find(item => item.key === key)?.label || key || '-';
}

function submissionModeLabel(mode: ScoringTaskRecord['submissionMode']) {
  if (mode === 'direct') return '疑似直接提交';
  if (mode === 'ranked') return '已操作排序';
  return '未记录';
}

function submissionModeType(mode: ScoringTaskRecord['submissionMode']) {
  if (mode === 'direct') return 'error';
  if (mode === 'ranked') return 'success';
  return 'default';
}

function taskIdFromItem(item: unknown) {
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  return String(record.id ?? record.taskId ?? record._id ?? '').trim();
}

function extractTaskIdsFromJson(payload: unknown) {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.taskIds)
      ? record.taskIds
      : Array.isArray(record?.ids)
        ? record.ids
        : Array.isArray(record?.tasks)
          ? record.tasks
          : Array.isArray(record?.rows)
            ? record.rows
            : [];
  const taskIds = [...new Set(source.map(taskIdFromItem).filter(Boolean))];
  if (!taskIds.length) throw new Error('JSON 中未找到可回退的任务 ID');
  return taskIds;
}

async function loadProjects() {
  projects.value = await imageApi.projects();
}

async function loadScorers() {
  scorersLoading.value = true;
  const pageSize = 100;
  try {
    const firstPage = await authApi.scorerUsers({ page: 1, pageSize });
    const pageCount = Math.ceil(firstPage.total / pageSize);
    const remainingPages = pageCount > 1
      ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => authApi.scorerUsers({
        page: index + 2,
        pageSize
      })))
      : [];
    const users = [firstPage, ...remainingPages].flatMap(page => page.users);
    scorerOptions.value = users.map(user => ({
      label: `${user.username}${user.status === 'disabled' ? '（已禁用）' : ''}`,
      value: user.username
    }));
  } finally {
    scorersLoading.value = false;
  }
}

async function loadSummary(page = scorerPage.value, pageSize = scorerPageSize.value) {
  loading.value = true;
  try {
    summary.value = await imageApi.adminScoringSummary({
      page,
      pageSize,
      scorer: filters.scorer,
      projectId: filters.projectId,
      submissionMode: filters.submissionMode
    });
    scorerPage.value = summary.value.page;
    scorerPageSize.value = summary.value.pageSize;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function loadDetail(page = detailPage.value, pageSize = detailPageSize.value) {
  const scorer = detailScorer.value?.scorer;
  if (!scorer) return;
  detailLoading.value = true;
  try {
    const result = await imageApi.adminScoringTasks({
      page,
      pageSize,
      scorer,
      projectId: filters.projectId,
      submissionMode: filters.submissionMode
    });
    detailRecords.value = result.tasks;
    detailTotal.value = result.total;
    detailPage.value = result.page;
    detailPageSize.value = result.pageSize;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    detailLoading.value = false;
  }
}

async function reloadSummary() {
  await loadSummary();
  if (detailVisible.value && detailScorer.value) {
    const nextScorer = summary.value?.scorers.find(item => item.scorer === detailScorer.value?.scorer);
    detailScorer.value = nextScorer || detailScorer.value;
    await loadDetail(detailPage.value, detailPageSize.value);
  }
}

function applyFilters() {
  scorerPage.value = 1;
  void reloadSummary();
}

function resetFilters() {
  filters.scorer = null;
  filters.projectId = null;
  filters.submissionMode = null;
  scorerPage.value = 1;
  void reloadSummary();
}

function changeScorerPage(page: number) {
  void loadSummary(page, scorerPageSize.value);
}

function changeScorerPageSize(pageSize: number) {
  void loadSummary(1, pageSize);
}

function scorerPaginationPrefix({ itemCount }: { itemCount?: number }) {
  return `共 ${itemCount ?? summary?.value?.scorerCount ?? 0} 位打分人`;
}

function openScorerDetails(row: ScoringSummaryScorer) {
  detailScorer.value = row;
  detailRecords.value = [];
  detailTotal.value = 0;
  detailPage.value = 1;
  detailVisible.value = true;
  void loadDetail(1, detailPageSize.value);
}

function closeScorerDetails() {
  detailVisible.value = false;
  detailScorer.value = null;
  detailRecords.value = [];
}

function changeDetailPage(page: number) {
  void loadDetail(page, detailPageSize.value);
}

function changeDetailPageSize(pageSize: number) {
  void loadDetail(1, pageSize);
}

function detailPaginationPrefix({ itemCount }: { itemCount?: number }) {
  return `共 ${itemCount ?? detailTotal.value} 条任务`;
}

function wait(milliseconds: number) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function waitForRollback(jobId: string, taskId: string) {
  while (true) {
    const job = await imageApi.scoringRollbackStatus(jobId);
    taskStack.updateTask(taskId, {
      progress: job.progress,
      stage: job.stage || '正在回退任务'
    });
    if (job.status === 'completed') {
      const result = job.result;
      if (!result) throw new Error('任务回退完成，但没有返回结果');
      taskStack.finishTask(taskId, {
        stage: '任务回退完成',
        description: `已回退 ${result.rolledBackTaskCount} 个任务`
      });
      message.success(`已回退 ${result.rolledBackTaskCount} 个任务`);
      await reloadSummary();
      return;
    }
    if (job.status === 'failed') {
      throw new Error(job.message || '任务回退失败');
    }
    await wait(800);
  }
}

async function handleRollbackFileChange(options: { file: UploadFileInfo }) {
  const file = options.file.file;
  if (!file) return;
  rollbackPreview.value = null;
  rollbackFileName.value = file.name;
  previewing.value = true;
  try {
    const payload = JSON.parse(await file.text()) as unknown;
    const taskIds = extractTaskIdsFromJson(payload);
    rollbackPreview.value = await imageApi.previewScoringRollback({ taskIds });
    rollbackVisible.value = true;
  } catch (error) {
    rollbackFileName.value = '';
    message.error(errorMessage(error));
  } finally {
    previewing.value = false;
  }
}

function confirmRollback() {
  const preview = rollbackPreview.value;
  if (!preview || !preview.taskIds.length) {
    message.error('没有可回退的任务');
    return;
  }
  dialog.warning({
    title: '确认回退任务',
    content: `将回退 ${preview.rollbackTaskCount} 个已完成任务，涉及 ${preview.scorers.length} 个打分人。回退后任务会重新出现在原打分人的任务列表中。`,
    positiveText: '确认回退',
    negativeText: '取消',
    onPositiveClick: async () => {
      rollbackSubmitting.value = true;
      let taskId = '';
      try {
        taskId = taskStack.addTask({
          kind: 'rollback',
          title: '批量回退任务',
          description: `${preview.rollbackTaskCount} 个任务 / ${preview.scorers.length} 个打分人`,
          stage: '正在提交回退作业',
          progress: 0
        });
        const job = await imageApi.rollbackScoringTasks({ taskIds: preview.taskIds });
        rollbackVisible.value = false;
        rollbackPreview.value = null;
        rollbackFileName.value = '';
        taskStack.updateTask(taskId, {
          progress: job.progress,
          stage: job.stage || '等待回退任务'
        });
        void waitForRollback(job.jobId, taskId).catch(error => {
          taskStack.failTask(taskId, error);
          message.error(`批量回退失败：${errorMessage(error)}`);
        });
        message.info('回退作业已提交，可在右下角任务栈查看进度');
      } catch (error) {
        if (taskId) taskStack.failTask(taskId, error);
        message.error(errorMessage(error));
        throw error;
      } finally {
        rollbackSubmitting.value = false;
      }
    }
  });
}

const scorerColumns: DataTableColumns<ScoringSummaryScorer> = [
  { title: '打分人', key: 'scorer', minWidth: 180 },
  { title: '涉及项目', key: 'projectCount', width: 110 },
  { title: '完成任务', key: 'totalTaskCount', width: 120 },
  {
    title: '疑似直接提交',
    key: 'directSubmitCount',
    width: 170,
    render: row => h('div', { class: 'scoring-inline-tags' }, [
      h(NTag, {
        size: 'small',
        type: row.directSubmitCount ? 'error' : 'default',
        bordered: false
      }, { default: () => formatNumber(row.directSubmitCount) }),
      h('span', { class: 'table-muted' }, formatPercent(row.directSubmitRate))
    ])
  },
  { title: '已操作排序', key: 'rankedSubmitCount', width: 120 },
  {
    title: '平均打分时间',
    key: 'averageDurationSeconds',
    width: 150,
    render: row => formatDuration(row.averageDurationSeconds)
  },
  { title: '回退次数', key: 'rollbackCount', width: 110 },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    fixed: 'right',
    render: row => h(NButton, {
      size: 'small',
      secondary: true,
      onClick: () => openScorerDetails(row)
    }, { default: () => '详情' })
  }
];

const detailColumns: DataTableColumns<ScoringTaskRecord> = [
  { title: '项目', key: 'projectName', minWidth: 180 },
  { title: '评分维度', key: 'criterion', minWidth: 150, render: row => criterionLabel(row.criterion) },
  {
    title: '提交方式',
    key: 'submissionMode',
    width: 150,
    render: row => h(NTag, {
      size: 'small',
      type: submissionModeType(row.submissionMode),
      bordered: false
    }, { default: () => submissionModeLabel(row.submissionMode) })
  },
  { title: '排序操作', key: 'rankingActionCount', width: 100 },
  { title: '打分时长', key: 'durationSeconds', width: 120, render: row => formatDuration(row.durationSeconds) },
  { title: '完成时间', key: 'completedAt', width: 180, render: row => formatDate(row.completedAt) },
  { title: '回退次数', key: 'rollbackCount', width: 100 }
];

async function initialize() {
  try {
    await Promise.all([loadProjects(), loadScorers()]);
  } catch (error) {
    message.error(errorMessage(error));
  }
  await loadSummary();
}

onMounted(() => void initialize());
</script>

<template>
  <div class="admin-page admin-account-content admin-scoring-content">
    <div class="table-shell account-table-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>打分管理</strong>
          <n-text depth="3">共 {{ summary?.scorerCount || 0 }} 位打分人</n-text>
        </div>
        <n-upload accept=".json,application/json" :default-upload="false" :show-file-list="false"
          @change="handleRollbackFileChange" style="width:100px">
          <n-button type="warning" secondary :loading="previewing">批量回退</n-button>
        </n-upload>
      </div>

      <div class="account-filter-bar scoring-account-filter-bar">
        <n-select v-model:value="filters.scorer" clearable filterable :loading="scorersLoading" :options="scorerOptions"
          placeholder="按打分人筛选" />
        <n-select v-model:value="filters.projectId" clearable filterable :options="projectOptions" placeholder="按项目筛选" />
        <n-select v-model:value="filters.submissionMode" clearable :options="submissionModeOptions"
          placeholder="按提交方式筛选" />
        <div class="account-filter-actions">
          <n-button type="primary" @click="applyFilters">查询</n-button>
          <n-button :disabled="!hasFilters" @click="resetFilters">重置</n-button>
        </div>
      </div>

      <div class="account-table-body">
        <n-data-table v-if="summary?.scorers.length" class="account-data-table" :columns="scorerColumns"
          :data="summary.scorers" :loading="loading" :bordered="false" :scroll-x="1050" />
        <div v-else class="empty">
          {{ loading ? '正在加载...' : (hasFilters ? '没有符合条件的打分人' : '暂无打分记录') }}
        </div>
      </div>
      <div class="account-table-footer">
        <n-pagination v-if="summary?.scorerCount" :page="scorerPage" :page-size="scorerPageSize"
          :item-count="summary.scorerCount" show-size-picker :page-sizes="[10, 20, 50, 100]"
          :prefix="scorerPaginationPrefix" @update:page="changeScorerPage"
          @update:page-size="changeScorerPageSize" />
      </div>
    </div>

    <n-modal v-model:show="detailVisible" preset="card" class="scoring-detail-modal" :bordered="false"
      :title="detailScorer ? `${detailScorer.scorer} 的打分详情` : '打分详情'" @after-leave="closeScorerDetails">
      <template v-if="detailScorer">
        <div class="scoring-detail-summary">
          <div>
            <span>涉及项目</span>
            <strong>{{ formatNumber(detailScorer.projectCount) }}</strong>
          </div>
          <div>
            <span>完成任务</span>
            <strong>{{ formatNumber(detailScorer.totalTaskCount) }}</strong>
          </div>
          <div>
            <span>疑似直接提交</span>
            <strong class="is-danger">{{ formatNumber(detailScorer.directSubmitCount) }}</strong>
          </div>
          <div>
            <span>平均打分时间</span>
            <strong>{{ formatDuration(detailScorer.averageDurationSeconds) }}</strong>
          </div>
        </div>

        <n-data-table :columns="detailColumns" :data="detailRecords" :loading="detailLoading" :bordered="false" remote
          :scroll-x="950" :max-height="520">
          <template #empty>
            <div class="scoring-table-empty">
              {{ detailLoading ? '正在加载任务明细...' : '暂无任务明细' }}
            </div>
          </template>
        </n-data-table>
        <div class="scoring-detail-footer">
          <n-pagination v-if="detailTotal" :page="detailPage" :page-size="detailPageSize" :item-count="detailTotal"
            show-size-picker :page-sizes="[10, 20, 50, 100]" :prefix="detailPaginationPrefix"
            @update:page="changeDetailPage" @update:page-size="changeDetailPageSize" />
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="rollbackVisible" preset="card" class="scoring-rollback-modal" :bordered="false" title="批量回退任务">
      <div v-if="rollbackPreview" class="scoring-rollback-body">
        <div class="scoring-rollback-summary">
          <n-text depth="3">{{ rollbackFileName || '已读取任务 JSON' }}</n-text>
          <n-tag size="small" type="success" :bordered="false">可回退 {{ rollbackPreview.rollbackTaskCount }} 个</n-tag>
          <n-tag size="small" type="warning" :bordered="false">忽略 {{ rollbackPreview.ignoredTaskCount }} 个</n-tag>
          <n-button type="warning" :loading="rollbackSubmitting" :disabled="!rollbackPreview.taskIds.length"
            @click="confirmRollback">
            确认回退
          </n-button>
        </div>

        <div class="scoring-rollback-overview">
          <div>
            <span>涉及打分人</span>
            <strong>{{ rollbackPreview.scorers.length }} 人</strong>
          </div>
          <div>
            <span>涉及任务</span>
            <strong>{{ rollbackPreview.rollbackTaskCount }} 个</strong>
          </div>
        </div>

        <n-text v-if="rollbackPreview.scorers.length" depth="3">
          {{ rollbackPreview.scorers.map(item => `${item.name}：${item.taskCount} 个`).join('，') }}
        </n-text>
      </div>
    </n-modal>
  </div>
</template>
