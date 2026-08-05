import type { ScoreCriterionKey, ScoreRange } from '../constants/scoreCriteria';

export type ScoreCriterionState = 'unrated' | 'rated' | 'not_applicable';
export type ScoreCriterionStates = Partial<Record<ScoreCriterionKey, ScoreCriterionState>>;

export interface ImageScore {
  overall?: number | null;
  creativity?: number | null;
  mood?: number | null;
  composition?: number | null;
  color?: number | null;
  lighting?: number | null;
  realism?: number | null;
  detail?: number | null;
  discomfort?: boolean | null;
  promptAlignment?: number | null;
  textCorrectness?: number | null;
  anatomyNormality?: number | null;
  informationClarity?: number | null;
  designQuality?: number | null;
  typography?: number | null;
  criterionStates?: ScoreCriterionStates;
  scorer?: string | null;
  comment?: string;
  ratedAt?: string;
}

export interface SubjectItem {
  _id: string;
  name: string;
  originalFilename: string;
  importBatch: string;
  imageCount: number;
  categoryCount: number;
  status: 'importing' | 'imported' | 'failed';
  createdAt: string;
  updatedAt: string;
  isLegacy?: boolean;
}

export interface ImageItem {
  _id: string;
  filename: string;
  category: string;
  imageUrl: string;
  subjectId?: string;
  score?: ImageScore;
}

export interface ImageQuery {
  subjectId?: string | null;
  category?: string | null;
  status?: 'rated' | 'unrated' | null;
  scorer?: string | null;
  scoreCriteria?: ScoreCriterionKey[] | null;
  scoreRanges?: Partial<Record<ScoreCriterionKey, ScoreRange>> | null;
}
export interface ImagePage { total: number; page: number; pageSize: number; items: ImageItem[]; }
