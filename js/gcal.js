// 「📅 Googleカレンダーに追加」のリンク（スケジュール画面の予定カード・参加予定、日程調整画面の「日程調整で決まった予定」で共通）。
// Googleの登録画面（calendar.google.com の action=TEMPLATE）を新しいタブで開くだけ。Google側の設定・認証は使わない。
// 時刻は日本時間のまま送り、ctz=Asia/Tokyo で解釈させる
const TITLE_MAX_LENGTH = 80;

const tokyoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// 日本時間の今日を「YYYY-MM-DD」で返す（予定の date と文字列のまま比べるため）
export function todayInTokyo() {
  return tokyoDateFormatter.format(new Date());
}

const pad = (n) => String(n).padStart(2, '0');

// 「YYYY-MM-DD」に日数を足す（端末のタイムゾーンに左右されないよう UTC で計算する）
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function compactDate(dateStr) {
  return dateStr.replace(/-/g, '');
}

function compactDateTime(dateStr, timeStr) {
  return `${compactDate(dateStr)}T${timeStr.slice(0, 5).replace(':', '')}00`;
}

// 終了時刻が無いときは開始の1時間後（23時台の開始なら翌日になる）
function oneHourLater(dateStr, timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + 60;
  const time = `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
  return compactDateTime(shiftDate(dateStr, Math.floor(total / 1440)), time);
}

// Googleの登録画面のURL。時刻が空なら終日（終わりは翌日を指定する決まり）。日付が無ければ null
export function buildGoogleCalendarUrl({ title, date, time, endTime, place, details }) {
  if (!date) return null;
  const text = String(title || '');
  const dates = time
    ? `${compactDateTime(date, time)}/${endTime ? compactDateTime(date, endTime) : oneHourLater(date, time)}`
    : `${compactDate(date)}/${compactDate(shiftDate(date, 1))}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH)}…` : text,
    dates,
    ctz: 'Asia/Tokyo',
  });
  if (place) params.set('location', String(place));
  if (details) params.set('details', String(details));
  return `https://calendar.google.com/calendar/render?${params}`;
}

// 新しいタブで開くリンク。行全体がクリックできる場所（参加予定）でも、行のクリックにしない。
// URLが作れない（日付が無い）ときは null（呼び出し側は何も置かない）
export function createGoogleCalendarLink(params, { label = '📅 Googleカレンダーに追加' } = {}) {
  const url = buildGoogleCalendarUrl(params);
  if (!url) return null;
  const link = document.createElement('a');
  link.className = 'btn btn-outline btn-small gcal-link';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer'; // アプリのURLを参照元として Google に渡さない
  link.textContent = label;
  link.title = 'Googleカレンダーに追加';
  link.setAttribute('aria-label', 'Googleカレンダーに追加');
  link.addEventListener('click', (e) => e.stopPropagation());
  return link;
}
