import { ref } from 'vue';

const STORAGE_KEY = 'image-rating.scorerName';

function readStoredScorerName() {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(STORAGE_KEY)?.trim() ?? '';
}

function persistScorerName(value: string) {
  if (typeof window === 'undefined') return;
  if (value) {
    window.localStorage.setItem(STORAGE_KEY, value);
  } else {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

function normalizeScorerName(value: string) {
  return value.trim();
}

export const scorerName = ref(readStoredScorerName());
export const scorerPromptVisible = ref(false);
export const scorerPromptValue = ref(scorerName.value);
export const scorerPromptError = ref('');

let pendingResolver: ((value: string | null) => void) | null = null;
let pendingPromise: Promise<string | null> | null = null;

function closeScorerPrompt(value: string | null) {
  scorerPromptVisible.value = false;
  pendingResolver?.(value);
  pendingResolver = null;
  pendingPromise = null;
}

export function setScorerName(value: string) {
  const next = normalizeScorerName(value);
  scorerName.value = next;
  persistScorerName(next);
  return next;
}

export function openScorerPrompt() {
  if (pendingPromise) return pendingPromise;
  scorerPromptValue.value = scorerName.value;
  scorerPromptError.value = '';
  scorerPromptVisible.value = true;
  pendingPromise = new Promise(resolve => {
    pendingResolver = resolve;
  });
  return pendingPromise;
}

export function requestScorerName() {
  if (scorerName.value) return Promise.resolve(scorerName.value);
  return openScorerPrompt();
}

export function submitScorerName() {
  const next = normalizeScorerName(scorerPromptValue.value);
  if (!next) {
    scorerPromptError.value = '请填写名字';
    return false;
  }
  scorerPromptError.value = '';
  setScorerName(next);
  closeScorerPrompt(next);
  return true;
}

export function cancelScorerName() {
  scorerPromptError.value = '';
  closeScorerPrompt(null);
}
