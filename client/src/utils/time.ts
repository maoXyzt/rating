export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

export function formatDateTime(value: string | number | Date | null | undefined) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: BUSINESS_TIME_ZONE })
    : '-';
}

export function shanghaiDateToUtc(date: string, dayOffset = 0) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + dayOffset) - 8 * 60 * 60 * 1000).toISOString();
}
