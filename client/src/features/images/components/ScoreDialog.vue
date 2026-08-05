<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { scorerName } from '../../../composables/scorer';
import { canMarkNotApplicable, type ScoreCriterionKey } from '../../../constants/scoreCriteria';
import { imageApi } from '../../../services/images';
import type { ImageItem, ImageScore, ScoreCriterionState } from '../../../types/image';

type Rule = { key: ScoreCriterionKey; label: string; tip?: string[]; canSkip?: boolean };
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

const artisticRules: Rule[] = [
  {
    key: 'creativity',
    label: '辨识度与创意感',
    tip: [
      '视觉记忆性、趣味性、视觉冲击力、天马行空的想象力',
    ]
  },
  {
    key: 'mood',
    label: '情绪与意境传达',
    tip: [
      '情绪传达度、氛围、意境、故事感',
    ]
  },
  {
    key: 'composition',
    label: '构图与视觉层级',
    tip: [
      '主体明确性、视觉层级清晰性、画面平衡性、视线引导性',
    ]
  },
  {
    key: 'color',
    label: '色彩配比',
    tip: [
      '色彩协调、或有明确控制且协调、或用色大胆且协调',
    ]
  },
  {
    key: 'lighting',
    label: '光照与光影',
    tip: [
      '光影和谐美观性、光影为画面的加分度、明暗层级是否协调',
    ]
  },
  {
    key: 'realism',
    label: '（肖像/摄像）真实感',
    tip: [
      '皮肤质感真实、材质可信度、摄影美观度、摄影真实性',

    ]
  },
  {
    key: 'detail',
    label: '细节与逻辑分辨率',
    tip: [
      '画面细节性',
    ]
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
    tip: ['生成结果与提示词中的主体、场景、风格和关键约束的一致程度。']
  },
  {
    key: 'textCorrectness',
    label: '文字正确性',
    canSkip: true,
    tip: ['画面里的文字是否正确、清晰、无错别字和乱码。']
  },
  {
    key: 'anatomyNormality',
    label: '肢体正常性',
    canSkip: true,
    tip: ['人物或生物的手脚、关节、五官和身体比例是否自然。']
  }
];

const infographicRules: Rule[] = [
  {
    key: 'informationClarity',
    label: '信息传达明确度',
    canSkip: true,
    tip: ['信息层级是否清楚，重点是否突出，阅读路径是否明确。']
  },
  {
    key: 'designQuality',
    label: '整体设计感',
    canSkip: true,
    tip: ['版式、元素、色彩和信息组织是否形成完整设计。']
  },
  {
    key: 'typography',
    label: '文字设计感',
    canSkip: true,
    tip: ['字体选择、排版、字距、行距与文字视觉表达是否协调。']
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
          </n-form-item>

          <template v-for="section in sections" :key="section.title">
            <h3 class="rule-title">{{ section.title }}</h3>
            <n-form-item v-for="rule in section.rules" :key="rule.key">
              <template #label>
                <div class="rule-label-block">
                  <span class="rule-label-title">{{ rule.label }}</span>
                  <div v-if="rule.tip?.length" class="rule-label-tip">
                    <div v-for="line in rule.tip" :key="line">{{ line }}</div>
                  </div>
                </div>
              </template>
              <div class="score-control-row">
                <n-rate
                  :value="score[rule.key] ?? null"
                  :count="10"
                  :disabled="isNotApplicable(rule.key)"
                  @update:value="updateScoreValue(rule.key, $event)"
                />
                <n-button
                  v-if="rule.canSkip"
                  class="score-na-button"
                  size="small"
                  :type="isNotApplicable(rule.key) ? 'warning' : 'default'"
                  secondary
                  @click="toggleNotApplicable(rule.key)"
                >
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
