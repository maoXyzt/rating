<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { scorerName } from '../../../composables/scorer';
import { canMarkNotApplicable, type ScoreCriterionKey } from '../../../constants/scoreCriteria';
import { imageApi } from '../../../services/images';
import sampleExampleImage from '../../../assets/images/test.webp';
import type { ImageItem, ImageScore, ScoreCriterionState } from '../../../types/image';

type ScoreExample = {
  src: string;
  score: number;
  title: string;
  note?: string;
};

type Rule = { key: ScoreCriterionKey; label: string; tip?: string[]; canSkip?: boolean; examples?: ScoreExample[] };
type Section = { title: string; rules: Rule[] };

const props = defineProps<{ show: boolean; image: ImageItem | null }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; saved: [value: ImageItem] }>();
const message = useMessage();
const saving = ref(false);

const emptyScore = (): ImageScore => ({
  overall: null,
  creativity: null,
  mood: null,
  composition: null,
  color: null,
  lighting: null,
  realism: null,
  detail: null,
  discomfort: null,
  promptAlignment: null,
  textCorrectness: null,
  anatomyNormality: null,
  informationClarity: null,
  designQuality: null,
  typography: null,
  criterionStates: {},
  scorer: null,
  comment: ''
});

const score = reactive<ImageScore>(emptyScore());
const isInfographic = computed(() => props.image?.category.includes('信息图') ?? false);

function buildExamples(items: Array<Omit<ScoreExample, 'src'>>) {
  return items.map(item => ({ src: sampleExampleImage, ...item }));
}

const technicalExamples = buildExamples([
  { score: 9, title: '高分参考', note: '主体、场景和约束都贴合。' },
  { score: 6, title: '中分参考', note: '核心方向对，但细节有偏差。' },
  { score: 3, title: '低分参考', note: '偏离提示词较明显。' },
  { score: 1, title: '极低分参考', note: '基本不符合要求。' }
]);

const artisticExamples = buildExamples([
  { score: 9, title: '高分参考', note: '记忆点强，画面完成度高。' },
  { score: 6, title: '中分参考', note: '有亮点，但整体表达还普通。' },
  { score: 3, title: '低分参考', note: '想法弱，画面辨识度低。' },
  { score: 1, title: '极低分参考', note: '几乎没有有效表达。' }
]);

const infographicExamples = buildExamples([
  { score: 9, title: '高分参考', note: '信息层级清楚，阅读路径顺。' },
  { score: 6, title: '中分参考', note: '能看懂，但重点不够突出。' },
  { score: 3, title: '低分参考', note: '结构散乱，组织感较弱。' },
  { score: 1, title: '极低分参考', note: '几乎无法支撑阅读。' }
]);

function scoreTagType(value: number) {
  if (value >= 8) return 'success';
  if (value >= 5) return 'warning';
  return 'error';
}

const artisticRules: Rule[] = [
  {
    key: 'creativity',
    label: '辨识度与创意感',
    tip: [
      '视觉记忆性、趣味性、视觉冲击力、天马行空的想象力',
    ],
    examples: artisticExamples
  },
  {
    key: 'mood',
    label: '情绪与意境传达',
    tip: [
      '情绪传达度、氛围、意境、故事感',
    ],
    examples: artisticExamples
  },
  {
    key: 'composition',
    label: '构图与视觉层级',
    tip: [
      '主体明确性、视觉层级清晰性、画面平衡性、视线引导性',
    ],
    examples: artisticExamples
  },
  {
    key: 'color',
    label: '色彩配比',
    tip: [
      '色彩协调、或有明确控制且协调、或用色大胆且协调',
    ],
    examples: artisticExamples
  },
  {
    key: 'lighting',
    label: '光照与光影',
    tip: [
      '光影和谐美观性、光影为画面的加分度、明暗层级是否协调',
    ],
    examples: artisticExamples
  },
  {
    key: 'realism',
    label: '（肖像/摄像）真实感',
    tip: [
      '皮肤质感真实、材质可信度、摄影美观度、摄影真实性',
    ],
    examples: artisticExamples
  },
  {
    key: 'detail',
    label: '细节与逻辑分辨率',
    tip: [
      '画面细节性',
    ],
    examples: artisticExamples
  }
];

const structureRules: Rule[] = [

];

const qualityRules: Rule[] = [

];

const technicalRules: Rule[] = [
  {
    key: 'promptAlignment',
    label: 'Prompt alignment',
    canSkip: true,
    tip: ['生成结果与提示词中的主体、场景、风格和关键约束的一致程度。'],
    examples: technicalExamples
  },
  {
    key: 'textCorrectness',
    label: '文字正确性',
    canSkip: true,
    tip: ['画面里的文字是否正确、清晰、无错别字和乱码。'],
    examples: technicalExamples
  },
  {
    key: 'anatomyNormality',
    label: '肢体正常性',
    canSkip: true,
    tip: ['人物或生物的手脚、关节、五官和身体比例是否自然。'],
    examples: technicalExamples
  }
];

const infographicRules: Rule[] = [
  {
    key: 'informationClarity',
    label: '信息传达明确度',
    canSkip: true,
    tip: ['信息层级是否清楚，重点是否突出，阅读路径是否明确。'],
    examples: infographicExamples
  },
  {
    key: 'designQuality',
    label: '整体设计感',
    canSkip: true,
    tip: ['版式、元素、色彩和信息组织是否形成完整设计。'],
    examples: infographicExamples
  },
  {
    key: 'typography',
    label: '文字设计感',
    canSkip: true,
    tip: ['字体选择、排版、字距、行距与文字视觉表达是否协调。'],
    examples: infographicExamples
  }
];

const sections = computed<Section[]>(() => [
  { title: '艺术表达', rules: artisticRules },
  // { title: '物理与感知结构（ISTA）', rules: structureRules },
  // { title: '技术质量与细节（IQA）', rules: qualityRules },
  { title: '技术维度', rules: technicalRules },
  ...(isInfographic.value ? [{ title: '信息图类追加(非信息图则不评价)', rules: infographicRules }] : [])
]);

const overallTip = ['独立一眼评估，不参考其它分项。'];
const discomfortTip = [
  '是否产生观感不舒适、恶心、厌恶、涉黄、暴力',
];

watch(
  () => props.image,
  image => {
    Object.assign(score, emptyScore(), image?.score);
    score.criterionStates = { ...(image?.score?.criterionStates ?? {}) };
  },
  { immediate: true }
);

function criterionState(key: ScoreCriterionKey): ScoreCriterionState {
  const state = score.criterionStates?.[key];
  if (state) return state;
  return score[key] == null ? 'unrated' : 'rated';
}

function isNotApplicable(key: ScoreCriterionKey) {
  return criterionState(key) === 'not_applicable';
}

function setCriterionState(key: ScoreCriterionKey, state: ScoreCriterionState) {
  if (!canMarkNotApplicable(key)) return;
  score.criterionStates = {
    ...(score.criterionStates ?? {}),
    [key]: state
  };
}

function updateScoreValue(key: ScoreCriterionKey, value: number | null) {
  if (isNotApplicable(key)) return;
  score[key] = value;
  if (canMarkNotApplicable(key)) {
    setCriterionState(key, value == null ? 'unrated' : 'rated');
  }
}

function toggleNotApplicable(key: ScoreCriterionKey) {
  if (!canMarkNotApplicable(key)) return;
  if (isNotApplicable(key)) {
    setCriterionState(key, 'unrated');
    return;
  }
  score[key] = null;
  setCriterionState(key, 'not_applicable');
}

async function save() {
  if (!props.image || saving.value) return;
  const scorer = scorerName.value.trim();
  if (!scorer) {
    message.error('请先填写打分人');
    return;
  }
  saving.value = true;
  try {
    const updated = await imageApi.saveScore(props.image._id, { ...score, scorer });
    emit('saved', updated);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

function close() {
  emit('update:show', false);
}
</script>

<template>
  <n-modal :show="show" preset="dialog" class="score-dialog" title="图片评分" :show-icon="false" positive-text="保存评分"
    negative-text="取消" @positive-click="save" @negative-click="close" @update:show="emit('update:show', $event)">
    <div v-if="image" class="rating-body">
      <n-image class="rating-image" :src="image.imageUrl" :preview-src="image.imageUrl" :alt="image.filename"
        object-fit="contain" show-toolbar-tooltip />
      <n-scrollbar class="rating-form-scroll" :style="{ maxHeight: 'calc(100vh - 220px)' }">
        <n-form label-placement="top">
          <n-form-item>
            <template #label>
              <div class="rule-label-block">
                <span class="rule-label-title">整体美感总分（独立一眼评）</span>
                <div class="rule-label-tip">
                  <div v-for="line in overallTip" :key="line">{{ line }}</div>
                </div>
              </div>
            </template>
            <n-rate v-model:value="score.overall" :count="10" />
            <n-tag type="success" style="margin-left: 30px">
              {{ score.overall ?? 0 }}
            </n-tag>

          </n-form-item>

          <template v-for="section in sections" :key="section.title">
            <h3 class="rule-title">{{ section.title }}</h3>
            <n-form-item v-for="rule in section.rules" :key="rule.key">
              <template #label>
                <div class="rule-label-block">
                  <div class="rule-label-row">
                    <span class="rule-label-title">{{ rule.label }}</span>
                    <n-popover v-if="rule.examples?.length" trigger="hover" placement="right-start" :show-arrow="true">
                      <template #trigger>
                        <button class="rule-help" type="button" aria-label="查看打分示例">
                          <n-icon size="14">
                            <svg t="1785919813557" class="icon" viewBox="0 0 1024 1024" version="1.1"
                              xmlns="http://www.w3.org/2000/svg" p-id="1715" width="15" height="15">
                              <path
                                d="M512 63.7C265.5 63.7 63.7 265.5 63.7 512S265.5 960.3 512 960.3 960.3 758.5 960.3 512 758.5 63.7 512 63.7m0 768.5c-35.3-0.1-64-28.7-64-64 0-35.2 28.8-64 64-64s64 28.8 64 64-28.8 64-64 64m83.3-483.5s0 3.2 0 0c0 3.2-54.5 256.1-54.5 256.1s3.2-19.2 0 0-12.8 28.8-28.8 28.8-25.6-12.8-28.8-32c-6.4-19.2-54.5-246.5-54.5-246.5 0-6.4-3.2-12.8-3.2-16 0-48 38.4-86.5 86.5-86.5s86.5 38.4 86.5 86.5c0 0-3.2 6.4-3.2 9.6"
                                fill="#666666" p-id="1716"></path>
                            </svg>
                          </n-icon>
                        </button>
                      </template>
                      <div class="rule-example-popover">
                        <div class="rule-example-header">
                          <div>
                            <div class="rule-example-title">示例图与分值</div>
                            <n-text depth="3">拖动滚动条查看更多示例</n-text>
                          </div>
                          <n-text depth="3">{{ rule.examples.length }} 张</n-text>
                        </div>
                        <n-scrollbar class="rule-example-scroll">
                          <div class="rule-example-grid">
                            <figure v-for="(example, index) in rule.examples" :key="`${rule.key}-${index}`" class="rule-example-card">
                              <div class="rule-example-media">
                                <img :src="example.src" :alt="`${rule.label} 示例 ${index + 1}`" loading="lazy" decoding="async" />
                                <n-tag size="small" :type="scoreTagType(example.score)" class="rule-example-score">
                                  {{ example.score }} 分
                                </n-tag>
                              </div>
                              <figcaption class="rule-example-caption">
                                <strong>{{ example.title }}</strong>
                                <span v-if="example.note">{{ example.note }}</span>
                              </figcaption>
                            </figure>
                          </div>
                        </n-scrollbar>
                      </div>
                    </n-popover>
                  </div>
                  <div v-if="rule.tip?.length" class="rule-label-tip">
                    <div v-for="line in rule.tip" :key="line">{{ line }}</div>
                  </div>
                </div>
              </template>
              <div class="score-control-row">
                <n-rate :value="score[rule.key] ?? null" :count="10" :disabled="isNotApplicable(rule.key)"
                  @update:value="updateScoreValue(rule.key, $event)" />
                <n-tag :type="isNotApplicable(rule.key) ? 'default' : 'success'" style="margin-left: 30px">
                  {{ isNotApplicable(rule.key) ? '-' : (score[rule.key] ?? 0) }}
                </n-tag>
                <n-button v-if="rule.canSkip" class="score-na-button" size="small"
                  :type="isNotApplicable(rule.key) ? 'warning' : 'default'" secondary
                  @click="toggleNotApplicable(rule.key)">
                  {{ isNotApplicable(rule.key) ? '已标记无需评价' : '无需评价' }}
                </n-button>
              </div>
            </n-form-item>
          </template>

          <h3 class="rule-title">安全与可用性底线</h3>
          <n-form-item>
            <template #label>
              <div class="rule-label-block">
                <span class="rule-label-title">不舒适与结构异常（一票否决：是 / 否）</span>
                <div class="rule-label-tip">
                  <div v-for="line in discomfortTip" :key="line">{{ line }}</div>
                </div>
              </div>
            </template>
            <n-radio-group v-model:value="score.discomfort">
              <n-radio :value="false">否</n-radio>
              <n-radio :value="true">是</n-radio>
            </n-radio-group>
          </n-form-item>

          <n-form-item label="备注">
            <n-input v-model:value="score.comment" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }"
              placeholder="可选" />
          </n-form-item>
        </n-form>
      </n-scrollbar>
    </div>
  </n-modal>
</template>
