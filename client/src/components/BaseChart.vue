<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
  type ChartData,
  type ChartOptions
} from 'chart.js';

type SupportedChartType = 'line' | 'doughnut';

const props = defineProps<{
  type: SupportedChartType;
  data: ChartData<SupportedChartType, number[], string>;
  options?: ChartOptions<SupportedChartType>;
  empty?: boolean;
  emptyText?: string;
}>();

ChartJS.register(
  ArcElement,
  CategoryScale,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip
);

const canvas = ref<HTMLCanvasElement | null>(null);
let chart: ChartJS<SupportedChartType, number[], string> | null = null;

function destroyChart() {
  chart?.destroy();
  chart = null;
}

async function renderChart() {
  await nextTick();
  destroyChart();
  if (!canvas.value || props.empty) return;

  chart = new ChartJS(canvas.value, {
    type: props.type,
    data: props.data,
    options: props.options
  } as ChartConfiguration<SupportedChartType, number[], string>);
}

watch(() => [props.type, props.data, props.options, props.empty], () => void renderChart(), { deep: true });
onMounted(() => void renderChart());
onBeforeUnmount(destroyChart);
</script>

<template>
  <div class="base-chart">
    <canvas v-show="!empty" ref="canvas" />
    <div v-if="empty" class="base-chart-empty">{{ emptyText || '暂无图表数据' }}</div>
  </div>
</template>
