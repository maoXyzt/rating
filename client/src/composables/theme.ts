import { computed, ref, watch } from 'vue';

type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'image-rating.theme';

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
}

const themeMode = ref<ThemeMode>(readStoredTheme());
const isDark = computed(() => themeMode.value === 'dark');
let watcherReady = false;

function applyTheme(mode: ThemeMode) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = mode;
  }
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  }
}

function ensureThemeWatcher() {
  if (watcherReady) return;
  watcherReady = true;
  watch(themeMode, applyTheme, { immediate: true });
}

export function useAppTheme() {
  ensureThemeWatcher();

  function toggleTheme() {
    themeMode.value = isDark.value ? 'light' : 'dark';
  }

  return {
    themeMode,
    isDark,
    toggleTheme,
  };
}
