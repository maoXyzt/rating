<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, watch } from 'vue';
import { NButton, useMessage, type DataTableColumns } from 'naive-ui';
import { useRoute, useRouter } from 'vue-router';
import ScoreDialog from '../features/images/components/ScoreDialog.vue';
import { canMarkNotApplicable, scoreCriteria, type ScoreCriterionKey, type ScoreRange } from '../constants/scoreCriteria';
import { imageApi } from '../services/images';
import type { ImageItem, ImagePage, ImageQuery, SubjectItem } from '../types/image';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const subjectId = decodeURIComponent(String(route.params.subjectId));
const pageSize = 20;

const subject = ref<SubjectItem | null>(null);
const categories = ref<string[]>([]);
const scorers = ref<string[]>([]);
const page = ref(1);
const loading = ref(false);
const sidebarCollapsed = ref(false);
const selectedImage = ref<ImageItem | null>(null);
const showScore = ref(false);
const imagePage = ref<ImagePage>({ total: 0, page: 1, pageSize, items: [] });
const filters = reactive<{
  category: string | null;
  scorer: string | null;
  status: ImageQuery['status'];
  criteria: ScoreCriterionKey[];
  ranges: Partial<Record<ScoreCriterionKey, ScoreRange>>;
}>({ category: null, scorer: null, status: null, criteria: [], ranges: {} });

const statusOptions = [
  { label: '未评分', value: 'unrated' },
  { label: '已评分', value: 'rated' }
] as const;

const criterionOptions = scoreCriteria.map(item => ({ label: `${item.group} · ${item.label}`, value: item.key }));
const scorerOptions = computed(() => scorers.value.map(value => ({ label: value, value })));

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function getCriterion(key: ScoreCriterionKey) {
  return scoreCriteria.find(item => item.key === key)!;
}

function rangeFor(key: ScoreCriterionKey): ScoreRange {
  return filters.ranges[key] ?? [1, 10];
}

function emptyPage(): ImagePage {
  return { total: 0, page: 1, pageSize, items: [] };
}

function renderScoreValue(row: ImageItem, key: ScoreCriterionKey) {
  if (canMarkNotApplicable(key) && row.score?.criterionStates?.[key] === 'not_applicable') {
    return '无需评价';
  }
  const value = row.score?.[key];
  return value == null ? '—' : value;
}

function getRowKey(row: ImageItem) {
  return row._id;
}

function updateCriteria(value: ScoreCriterionKey[] | null) {
  const nextCriteria = value ?? [];
  const nextRanges = { ...filters.ranges };

  nextCriteria.forEach(key => {
    if (!nextRanges[key]) nextRanges[key] = [1, 10];
  });

  (Object.keys(nextRanges) as ScoreCriterionKey[]).forEach(key => {
    if (!nextCriteria.includes(key)) delete nextRanges[key];
  });

  filters.criteria = nextCriteria;
  filters.ranges = nextRanges;
}

function updateRange(key: ScoreCriterionKey, value: [number, number] | null) {
  if (!value) return;
  filters.ranges[key] = [Math.max(1, Math.min(10, value[0])), Math.max(1, Math.min(10, value[1]))];
}

function updateRangePoint(key: ScoreCriterionKey, index: 0 | 1, value: number | null) {
  const next = [...rangeFor(key)] as ScoreRange;
  next[index] = Math.max(1, Math.min(10, value ?? (index === 0 ? 1 : 10)));
  filters.ranges[key] = [Math.min(next[0], next[1]), Math.max(next[0], next[1])];
}

function sliderHandler(key: ScoreCriterionKey) {
  return (value: [number, number] | null) => updateRange(key, value);
}

function rangePointHandler(key: ScoreCriterionKey, index: 0 | 1) {
  return (value: number | null) => updateRangePoint(key, index, value);
}

async function loadImages() {
  loading.value = true;
  try {
    imagePage.value = await imageApi.list({
      subjectId,
      category: filters.category,
      scorer: filters.scorer,
      status: filters.status,
      scoreCriteria: filters.criteria,
      scoreRanges: filters.ranges,
      page: page.value,
      pageSize
    });
  } catch (error) {
    imagePage.value = emptyPage();
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function loadPage() {
  try {
    const [subjects, subjectCategories, subjectScorers] = await Promise.all([
      imageApi.subjects(),
      imageApi.categories(subjectId),
      imageApi.scorers(subjectId)
    ]);
    subject.value = subjects.find(item => item._id === subjectId) ?? null;
    categories.value = subjectCategories.sort((a, b) => a.localeCompare(b));
    scorers.value = subjectScorers.sort((a, b) => a.localeCompare(b));
    if (!subject.value) {
      message.error('图包不存在');
      await router.push('/admin');
      return;
    }
    await loadImages();
  } catch (error) {
    message.error(errorMessage(error));
  }
}

function applyFilters() {
  if (page.value === 1) {
    void loadImages();
    return;
  }
  page.value = 1;
}

function resetFilters() {
  filters.category = null;
  filters.scorer = null;
  filters.status = null;
  filters.criteria = [];
  filters.ranges = {};
  applyFilters();
}

function openScore(image: ImageItem) {
  selectedImage.value = image;
  showScore.value = true;
}

function handleScoreSaved(updated: ImageItem) {
  const index = imagePage.value.items.findIndex(item => item._id === updated._id);
  const nextImage = index >= 0 ? imagePage.value.items[index + 1] ?? null : null;

  if (index >= 0) imagePage.value.items[index] = updated;
  message.success('评分已保存');

  if (nextImage) {
    selectedImage.value = nextImage;
    showScore.value = true;
  } else {
    selectedImage.value = null;
    showScore.value = false;
  }

  void loadImages();
}

watch(page, () => void loadImages());
onMounted(() => void loadPage());

const scoreColumns = computed<DataTableColumns<ImageItem>>(() => {
  const grouped = scoreCriteria.reduce((acc, item) => {
    const group = acc.find(entry => entry.group === item.group);
    if (group) {
      group.items.push(item);
    } else {
      acc.push({ group: item.group, items: [item] });
    }
    return acc;
  }, [] as Array<{ group: string; items: typeof scoreCriteria[number][] }>);

  const columns: DataTableColumns<ImageItem> = [];

  grouped.forEach(group => {
    if (group.items.length === 1 && group.items[0].key === 'overall') {
      columns.push({
        title: group.items[0].label,
        key: group.items[0].key,
        width: 110,
        render: row => renderScoreValue(row, group.items[0].key)
      });
      return;
    }

    columns.push({
      title: group.group,
      key: `group-${group.group}`,
      children: group.items.map(item => ({
        title: item.label,
        key: item.key,
        width: 120,
        render: row => renderScoreValue(row, item.key)
      }))
    });
  });

  return columns;
});

const columns = computed<DataTableColumns<ImageItem>>(() => [
  {
    title: '缩略图',
    key: 'imageUrl',
    width: 110,
    render: row => h('img', { src: row.imageUrl, alt: row.filename, class: 'table-thumbnail' })
  },
  { title: '文件名', key: 'filename', minWidth: 220, ellipsis: { tooltip: true } },
  { title: '目录', key: 'category', minWidth: 160, ellipsis: { tooltip: true } },
  { title: '打分人', key: 'scorer', width: 120, ellipsis: { tooltip: true }, render: row => row.score?.scorer || '—' },
  ...scoreColumns.value,
  {
    title: '评分时间',
    key: 'ratedAt',
    width: 180,
    render: row => (row.score?.ratedAt ? new Date(row.score.ratedAt).toLocaleString() : '未评分')
  },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    fixed: 'right',
    render: row => h(NButton, { size: 'small', secondary: true, onClick: () => openScore(row) }, { default: () => '评分' })
  }
]);

const tableScrollX = computed(() => 940 + scoreCriteria.length * 120);
</script>

<template>
  <n-layout class="main admin-subject-main">
    <n-layout-content class="content admin-content admin-subject-content">
      <div class="admin-subject-workbench">
        <aside class="subject-sidebar" :class="{ 'is-collapsed': sidebarCollapsed }">
          <div class="subject-sidebar-header" :class="{ 'is-collapsed': sidebarCollapsed }">
            <div v-if="!sidebarCollapsed" class="subject-sidebar-heading">
              <n-text depth="3">筛选条件</n-text>
              <strong>目录、评分状态、评分标准</strong>
            </div>
            <n-button size="small" secondary @click="sidebarCollapsed = !sidebarCollapsed">
              {{ sidebarCollapsed ? '展开' : '收起' }}
            </n-button>
          </div>

          <div v-show="!sidebarCollapsed" class="subject-sidebar-body">
            <n-form label-placement="top">
              <n-form-item label="目录分类">
                <n-select
                  v-model:value="filters.category"
                  clearable
                  filterable
                  :options="categories.map(value => ({ label: value, value }))"
                  placeholder="全部目录"
                />
              </n-form-item>
              <n-form-item label="打分人">
                <n-select
                  v-model:value="filters.scorer"
                  clearable
                  filterable
                  :options="scorerOptions"
                  placeholder="全部打分人"
                />
              </n-form-item>
              <n-form-item label="评分状态">
                <n-select
                  v-model:value="filters.status"
                  clearable
                  placeholder="全部状态"
                  :options="statusOptions"
                />
              </n-form-item>
              <n-form-item label="评分标准（可多选）">
                <n-select
                  :value="filters.criteria"
                  multiple
                  clearable
                  filterable
                  :options="criterionOptions"
                  placeholder="选择评分标准"
                  @update:value="updateCriteria"
                />
              </n-form-item>
            </n-form>

            <div v-if="filters.criteria.length" class="score-range-grid">
              <div v-for="criterion in filters.criteria" :key="criterion" class="score-range-item">
                <div class="score-range-header">
                  <strong>{{ getCriterion(criterion).label }}</strong>
                  <n-text depth="3">{{ rangeFor(criterion)[0] }} - {{ rangeFor(criterion)[1] }} 分</n-text>
                </div>
                <n-slider
                  :value="rangeFor(criterion)"
                  range
                  :min="1"
                  :max="10"
                  :step="1"
                  :on-update:value="sliderHandler(criterion)"
                />
                <div class="range-inputs">
                  <n-input-number
                    :value="rangeFor(criterion)[0]"
                    :min="1"
                    :max="10"
                    size="small"
                    :on-update:value="rangePointHandler(criterion, 0)"
                  />
                  <n-input-number
                    :value="rangeFor(criterion)[1]"
                    :min="1"
                    :max="10"
                    size="small"
                    :on-update:value="rangePointHandler(criterion, 1)"
                  />
                </div>
              </div>
            </div>

            <div class="subject-sidebar-actions">
              <n-button secondary @click="resetFilters">重置</n-button>
              <n-button type="primary" @click="applyFilters">筛选</n-button>
            </div>
          </div>
        </aside>

        <section class="subject-panel">
          <div class="subject-panel-header">
            <div class="subject-panel-title">
              <n-button link @click="router.push('/admin')">返回图包列表</n-button>
              <n-h2 class="page-title">{{ subject?.name || '图包详情' }}</n-h2>
              <n-text depth="3">
                {{ subject ? `${subject.imageCount} 张图片 / ${subject.categoryCount} 个目录` : '正在加载图包信息...' }}
              </n-text>
            </div>
          </div>

          <div class="subject-table-shell">
            <div class="subject-table-header">
              <div>
                <strong>图片列表</strong>
                <n-text depth="3">共 {{ imagePage.total }} 张</n-text>
              </div>
            </div>

            <div class="subject-table-body">
              <n-data-table
                class="subject-data-table"
                :columns="columns"
                :data="imagePage.items"
                :loading="loading"
                :bordered="false"
                striped
                size="small"
                :row-key="getRowKey"
                :scroll-x="tableScrollX"
                flex-height
                max-height="100%"
              />
            </div>

            <div class="subject-table-footer">
              <n-pagination
                v-if="imagePage.total"
                v-model:page="page"
                :page-size="pageSize"
                :item-count="imagePage.total"
                class="subject-pagination"
              />
            </div>
          </div>
        </section>
      </div>
    </n-layout-content>
    <ScoreDialog v-model:show="showScore" :image="selectedImage" @saved="handleScoreSaved" />
  </n-layout>
</template>
