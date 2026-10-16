// お知らせ（ヘッダーの 🔔 と未読数、お知らせ一覧、種類ごとのオンオフ）。お知らせ機能の段階1（migration 0028）。
// 全ページ共通。各ページは、有効な利用者のログインを確かめたあとに initNotifications() を1回呼ぶ。
// Supabase の転送量を増やさないため、Realtime は使わず、次のときだけ読む:
//   ・未読数 … ページを開いたとき・タブに戻ったとき（前回から60秒以上たっていれば）・一覧で既読にしたあと。件数だけ（head: 中身は返らない）
//   ・一覧（新しい30件）と設定 … 一覧を開いたときだけ
// 読み取りは本人だけが読める RLS で直接。書き込み（既読・設定）は api/users.js（service_role）から。
// 画面に出す文字（題名・本文・設定の説明など）は、すべて textContent で入れる（innerHTML は使わない）
import { getSupabaseClient } from './supabase-client.js';
import { usersApi } from './auth.js';

const LIST_LIMIT = 30;
const REFRESH_INTERVAL_MS = 60 * 1000;
const LIST_COLUMNS = 'id, kind, title, body, url, created_at, read_at';
// 画面に出すスイッチ。①前日の予告（event_reminder）は、届くようになる段階3で足す（表の列は migration 0028 で作ってある）
const SETTINGS = [
  { key: 'event_created', label: '新しい予定', hint: '自分の支部に予定が登録されたとき（県連の予定は、県連内の全支部に届きます）' },
  { key: 'coordination_created', label: '日程調整の立ち上げ', hint: '自分の支部で日程調整が作られたとき' },
  { key: 'coordination_decided', label: '日程調整の決定', hint: '自分の支部の日程調整の日程が決まったとき' },
  { key: 'event_changed', label: '参加する予定の変更・削除', hint: '「参加」で登録した予定の日時・場所が変わったとき、削除されたとき' },
];

const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const els = {};
let initialized = false;
let lastCountAt = 0;

export function initNotifications() {
  if (initialized) return;
  const logoutBtn = document.getElementById('logout-btn');
  if (!logoutBtn) return;
  initialized = true;
  buildBell(logoutBtn);
  buildDialog();
  refreshUnreadCount({ force: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshUnreadCount();
  });
}

function hint(text) {
  const p = document.createElement('p');
  p.className = 'hint-text';
  p.textContent = text;
  return p;
}

// ===================== ベル =====================

function buildBell(logoutBtn) {
  const bell = document.createElement('button');
  bell.type = 'button';
  bell.className = 'notif-bell';
  bell.title = 'お知らせ';
  bell.setAttribute('aria-label', 'お知らせ');
  bell.textContent = '🔔';
  const badge = document.createElement('span');
  badge.className = 'notif-badge hidden';
  bell.appendChild(badge);
  bell.addEventListener('click', openDialog);
  logoutBtn.before(bell);
  els.bell = bell;
  els.badge = badge;
}

function setBadge(count) {
  els.badge.textContent = count > 99 ? '99+' : String(count);
  els.badge.classList.toggle('hidden', !count);
  els.bell.setAttribute('aria-label', count ? `お知らせ（未読${count}件）` : 'お知らせ');
}

// 未読数（件数だけ）。force でなければ、前回から60秒たつまでは読み直さない
async function refreshUnreadCount({ force = false } = {}) {
  if (!force && Date.now() - lastCountAt < REFRESH_INTERVAL_MS) return;
  lastCountAt = Date.now();
  try {
    const supabase = await getSupabaseClient();
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null);
    if (error) throw error;
    setBadge(count || 0);
  } catch (err) {
    console.error('お知らせの未読数の取得に失敗:', err);
  }
}

// ===================== 一覧と設定 =====================

function buildDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'csv-export-dialog notif-dialog';

  const inner = document.createElement('div');
  inner.className = 'notif-dialog-inner';

  const header = document.createElement('div');
  header.className = 'notif-dialog-header';
  const title = document.createElement('h2');
  title.className = 'csv-export-title';
  title.textContent = 'お知らせ';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-outline btn-small';
  close.textContent = '閉じる';
  close.addEventListener('click', () => dialog.close());
  header.append(title, close);

  const list = document.createElement('div');
  list.className = 'notif-list';

  const settings = document.createElement('details');
  settings.className = 'notif-settings';
  const summary = document.createElement('summary');
  summary.textContent = '⚙ 通知の設定';
  const form = document.createElement('div');
  form.className = 'notif-settings-body';
  settings.append(summary, form);

  inner.append(header, list, settings);
  dialog.appendChild(inner);
  document.body.appendChild(dialog);
  Object.assign(els, { dialog, list, settingsForm: form });
}

async function openDialog() {
  els.dialog.showModal();
  els.list.replaceChildren(hint('読み込み中…'));
  try {
    const supabase = await getSupabaseClient();
    const [listResult, settingsResult] = await Promise.all([
      supabase.from('notifications').select(LIST_COLUMNS).order('created_at', { ascending: false }).limit(LIST_LIMIT),
      supabase.from('notification_settings').select(SETTINGS.map((s) => s.key).join(', ')).maybeSingle(),
    ]);
    if (listResult.error) throw listResult.error;
    const rows = listResult.data || [];
    renderList(rows);
    if (settingsResult.error) console.error(settingsResult.error);
    renderSettings(settingsResult.data || {});
    // 開いたら、表示した行のうち未読だったものだけを既読にする（読み込んだあとに届いたお知らせを、見ないまま既読にしないため）。
    // そのあと未読数を読み直す（30件より古い未読が残っていれば、その数が出る）
    const unreadIds = rows.filter((row) => !row.read_at).map((row) => row.id);
    if (unreadIds.length > 0) {
      await usersApi('notifications_read', 'POST', { ids: unreadIds });
      await refreshUnreadCount({ force: true });
    }
  } catch (err) {
    console.error(err);
    els.list.replaceChildren(hint('お知らせを読み込めませんでした。時間をおいて再度お試しください'));
  }
}

// 開いたときに未読だったものは is-unread（薄い背景）で目立たせる。url があれば押すとその画面へ移動
function renderList(rows) {
  if (rows.length === 0) {
    els.list.replaceChildren(hint('お知らせはまだありません'));
    return;
  }
  els.list.replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement(row.url ? 'a' : 'div');
      item.className = row.read_at ? 'notif-item' : 'notif-item is-unread';
      if (row.url) item.href = row.url;
      const title = document.createElement('p');
      title.className = 'notif-item-title';
      title.textContent = row.title;
      item.appendChild(title);
      if (row.body) {
        const body = document.createElement('p');
        body.className = 'notif-item-body';
        body.textContent = row.body;
        item.appendChild(body);
      }
      const time = document.createElement('p');
      time.className = 'notif-item-time';
      time.textContent = dateTimeFormatter.format(new Date(row.created_at));
      item.appendChild(time);
      return item;
    })
  );
}

// 行が無い人（一度も変えていない人）はすべて ON。変えたらすぐ保存し、失敗したら元に戻す
function renderSettings(current) {
  els.settingsForm.replaceChildren(
    ...SETTINGS.map(({ key, label, hint: hintText }) => {
      const row = document.createElement('label');
      row.className = 'notif-setting';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = current[key] !== false;
      input.addEventListener('change', async () => {
        input.disabled = true;
        try {
          await usersApi('notification_settings', 'POST', { [key]: input.checked });
        } catch (err) {
          input.checked = !input.checked;
          alert(err.message);
        } finally {
          input.disabled = false;
        }
      });
      const text = document.createElement('span');
      text.className = 'notif-setting-text';
      const name = document.createElement('span');
      name.className = 'notif-setting-label';
      name.textContent = label;
      const small = document.createElement('span');
      small.className = 'notif-setting-hint';
      small.textContent = hintText;
      text.append(name, small);
      row.append(input, text);
      return row;
    })
  );
}
