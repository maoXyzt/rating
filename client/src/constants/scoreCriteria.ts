export const scoreCriteria = [
  { key: 'overall', label: '整体美感总分', group: '总分' },
  { key: 'creativity', label: '辨识度与创意感', group: '艺术表达' },
  { key: 'mood', label: '情绪与意境传达', group: '艺术表达' },
  { key: 'composition', label: '构图与视觉层级', group: '艺术表达' },
  { key: 'color', label: '色彩配比', group: '艺术表达' },
  { key: 'lighting', label: '光照与光影', group: '艺术表达' },
  { key: 'realism', label: '真实世界物理与材质再现', group: '物理与感知结构' },
  { key: 'detail', label: '细节深度与技术瑕疵排查', group: '技术质量与细节' },
  { key: 'promptAlignment', label: 'Prompt alignment', group: '技术维度' },
  { key: 'textCorrectness', label: '文字正确性', group: '技术维度' },
  { key: 'anatomyNormality', label: '肢体正常性', group: '技术维度' },
  { key: 'informationClarity', label: '信息传达明确度', group: '信息图类' },
  { key: 'designQuality', label: '整体设计感', group: '信息图类' },
  { key: 'typography', label: '文字设计感', group: '信息图类' }
] as const;

export type ScoreCriterionKey = typeof scoreCriteria[number]['key'];
export type ScoreRange = [number, number];

export const notApplicableScoreCriterionKeys = [
  'promptAlignment',
  'textCorrectness',
  'anatomyNormality',
  'informationClarity',
  'designQuality',
  'typography'
] as const satisfies readonly ScoreCriterionKey[];

export type NotApplicableScoreCriterionKey = typeof notApplicableScoreCriterionKeys[number];

const notApplicableScoreCriterionSet: ReadonlySet<ScoreCriterionKey> = new Set(notApplicableScoreCriterionKeys);

export function canMarkNotApplicable(key: ScoreCriterionKey): key is NotApplicableScoreCriterionKey {
  return notApplicableScoreCriterionSet.has(key);
}
