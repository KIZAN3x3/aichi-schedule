let holidaySet = null;

export async function loadHolidays() {
  const cacheKey = 'aichi-schedule:holidays';
  const cacheTimeKey = 'aichi-schedule:holidays-time';
  const cached = localStorage.getItem(cacheKey);
  const cachedTime = localStorage.getItem(cacheTimeKey);
  const oneDay = 24 * 60 * 60 * 1000;

  if (cached && cachedTime && Date.now() - Number(cachedTime) < oneDay) {
    holidaySet = new Set(JSON.parse(cached));
    return;
  }

  try {
    const res = await fetch('https://holidays-jp.github.io/api/v1/date.json');
    const data = await res.json();
    const dates = Object.keys(data);
    holidaySet = new Set(dates);
    localStorage.setItem(cacheKey, JSON.stringify(dates));
    localStorage.setItem(cacheTimeKey, String(Date.now()));
  } catch (err) {
    console.error('祝日データの取得に失敗しました', err);
    if (cached) {
      holidaySet = new Set(JSON.parse(cached));
    } else {
      holidaySet = new Set();
    }
  }
}

export function isHoliday(dateStr) {
  return holidaySet ? holidaySet.has(dateStr) : false;
}
