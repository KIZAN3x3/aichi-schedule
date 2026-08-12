const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// タイムゾーンずれを避けるため、常にローカル日付の年月日から組み立てる
export function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date, diff) {
  return new Date(date.getFullYear(), date.getMonth() + diff, 1);
}

export function formatMonthLabel(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

export function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${y}年${m}月${d}日(${WEEKDAY_LABELS[date.getDay()]})`;
}

export function formatMonthRange(monthStart) {
  const start = toDateStr(monthStart);
  const end = toDateStr(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0));
  return { start, end };
}

export { WEEKDAY_LABELS };
