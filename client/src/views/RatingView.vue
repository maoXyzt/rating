<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import ImageFilters from '../features/images/components/ImageFilters.vue';
import ScoreDialog from '../features/images/components/ScoreDialog.vue';
import { requestScorerName } from '../composables/scorer';
import { imageApi } from '../services/images';
import type { ImageItem, ImagePage, ImageQuery, SubjectItem } from '../types/image';

const message = useMessage();
const filters = reactive<ImageQuery>({ category: null, status: null });
const subjects = ref<SubjectItem[]>([]);
const selectedSubjectId = ref<string | null>(null);
const categories = ref<string[]>([]);
const page = ref(1);
const imagePage = ref<ImagePage>(emptyPage());
const selectedImage = ref<ImageItem | null>(null);
const showScore = ref(false);
const subjectsLoading = ref(false);
const categoriesLoading = ref(false);
const imagesLoading = ref(false);
let switchingSubject = false;

const availableSubjects = computed(() => subjects.value.filter(subject => subject.status === 'imported'));
const subjectOptions = computed(() => availableSubjects.value.map(subject => ({ label: `${subject.name}（${subject.imageCount} 张）`, value: subject._id })));
const selectedSubject = computed(() => subjects.value.find(subject => subject._id === selectedSubjectId.value) ?? null);

function emptyPage(): ImagePage { return { total: 0, page: 1, pageSize: 20, items: [] }; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '请求失败'; }

async function loadSubjects() {
  subjectsLoading.value = true;
  try {
    subjects.value = await imageApi.subjects();
    const firstSubject = availableSubjects.value[0];
    if (!selectedSubjectId.value && firstSubject) {
      selectedSubjectId.value = firstSubject._id;
    }
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    subjectsLoading.value = false;
  }
}

async function loadCategories(subjectId: string) {
  categoriesLoading.value = true;
  try {
    categories.value = await imageApi.categories(subjectId);
  } catch (error) {
    categories.value = [];
    message.error(errorMessage(error));
  } finally {
    categoriesLoading.value = false;
  }
}

async function load() {
  if (!selectedSubjectId.value) {
    imagePage.value = emptyPage();
    return;
  }
  imagesLoading.value = true;
  try {
    imagePage.value = await imageApi.list({ ...filters, subjectId: selectedSubjectId.value, page: page.value, pageSize: 20 });
  } catch (error) {
    imagePage.value = emptyPage();
    message.error(errorMessage(error));
  } finally {
    imagesLoading.value = false;
  }
}

function updateFilters(value: ImageQuery) {
  Object.assign(filters, value);
}

watch(selectedSubjectId, async subjectId => {
  switchingSubject = true;
  page.value = 1;
  filters.category = null;
  filters.status = null;
  if (!subjectId) {
    categories.value = [];
    imagePage.value = emptyPage();
    switchingSubject = false;
    return;
  }
  await loadCategories(subjectId);
  await load();
  switchingSubject = false;
});
watch(filters, () => { if (!switchingSubject) { page.value = 1; void load(); } }, { deep: true });
watch(page, () => { if (!switchingSubject) void load(); });
onMounted(() => void loadSubjects());

async function openScore(image: ImageItem) {
  const scorer = await requestScorerName();
  if (!scorer) return;
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
  void load();
}
</script>

<template>
  <n-layout has-sider class="main">
    <n-layout-sider bordered class="sidebar" :width="260" :native-scrollbar="false" content-style="overflow: visible">
      <div class="sidebar-panel">
        <ImageFilters :modelValue="filters" :categories="categories" :disabled="!selectedSubjectId"
          :loading="categoriesLoading" @update:modelValue="updateFilters" />
      </div>
    </n-layout-sider>
    <n-layout-content class="content">
      <div class="page-toolbar">
        <div>
          <n-h2 class="page-title">图片评分</n-h2>
          <n-text depth="3">{{ selectedSubject ? `${selectedSubject.categoryCount} 个目录 / ${selectedSubject.imageCount}
            张图片` : '请选择图包' }}</n-text>
        </div>
        <n-select v-model:value="selectedSubjectId" class="subject-select" clearable filterable :loading="subjectsLoading"
          placeholder="请选择图包" :options="subjectOptions" />
      </div>
      <div v-if="!selectedSubjectId" class="empty">请选择图包</div>
      <template v-else>
        <div v-if="imagePage.items.length" class="grid">
          <n-card v-for="image in imagePage.items" :key="image._id" class="card" hoverable content-style="padding: 0"
            @click="openScore(image)">
            <div class="card-image-shell">
              <img class="card-image-preview" :src="image.imageUrl" :alt="image.filename" width="100%" height="100%"
                object-fit="cover" />
            </div>
            <div class="meta">
              <n-ellipsis>{{ image.filename }}</n-ellipsis>
              <n-space justify="space-between" align="center">
                <n-tag size="small">{{ image.category }}</n-tag>
                <n-tag size="small" :type="image.score?.overall ? 'success' : 'default'">{{ image.score?.overall ? `总分
                  ${image.score.overall}` : '待评分' }}</n-tag>
              </n-space>
            </div>
          </n-card>
        </div>
        <div v-else class="empty">{{ imagesLoading ? '正在加载图片...' : '当前筛选下暂无图片' }}</div>
        <n-pagination v-if="imagePage.total" v-model:page="page" :page-size="20" :item-count="imagePage.total"
          style="margin-top: 24px" />
      </template>
    </n-layout-content>
  </n-layout>
  <ScoreDialog v-model:show="showScore" :image="selectedImage" @saved="handleScoreSaved" />
</template>
