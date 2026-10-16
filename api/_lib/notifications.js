// お知らせ（アプリ内のお知らせ一覧）を作る共通の処理。お知らせ機能の段階1（migration 0028）。
// 予定・日程調整の API が、元の操作のあとに notifySafely で包んで呼ぶ（失敗しても元の操作は成功のまま）。
// supabase（service_role のクライアント）は呼び出し側から受け取る。
// 届く人:
//   ・1〜16支部の予定・調整 … その支部に所属する有効な人
//   ・西県連・東県連の予定・調整 … その県連（branch_regions）の全支部と県連に所属する有効な人
//     （branch_regions には西県連・東県連自身の行もあるため、県連に所属する人も入る）
//   ・ブラインドの調整の決定 … 作成者・回答した人・代理登録した人だけ（管理者には届けない）
//   ・参加した予定の変更・削除 … status='going' で participant_user_id がある人
//   ・操作した本人には届けない（①前日の予告だけは段階3で例外にする）
//   ・本人がその種類を OFF にしていれば作らない（notification_settings。行が無ければすべて ON）
// ローカルの確認用: 環境変数 NOTIFICATIONS_TEST_ALLOWLIST（app_users.id のカンマ区切り）があれば、その人にだけ作る。
//   本物のメンバーにテストのお知らせが届かないようにするため。本番（Vercel）には置かない。
//   開発サーバー（npx vercel dev）が読むのは .env（.env.local は読まない）ので、確認のときは .env に置き、終わったら戻す。
//   開発サーバーでは、許可リストが空ならお知らせを1件も作らない（安全側に倒す）

// お知らせの種類 → オンオフの列（⑤の変更と削除は同じスイッチ）
const SETTING_OF_KIND = {
  event_reminder: 'event_reminder',
  event_created: 'event_created',
  coordination_created: 'coordination_created',
  coordination_decided: 'coordination_decided',
  event_changed: 'event_changed',
  event_deleted: 'event_changed',
};
// 県連の予定・調整は、その県連の全支部に届ける
const REGION_OF_HQ = { 西県連: '西', 東県連: '東' };
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const TITLE_MAX_LENGTH = 100;
const BODY_MAX_LENGTH = 300;
const INSERT_CHUNK = 500;
// ⑤で「変わった」とみなす列（内容・カテゴリ・終了・戻すは通知しない）
const CHANGE_FIELDS = ['date', 'time', 'end_time', 'place'];
// ローカルの開発サーバー（npx vercel dev）か。開発サーバーは関数に NOW_REGION=dev1 を渡す
// （VERCEL_ENV=development は関数には渡らない）。本番・プレビューの NOW_REGION は実際の地域（hnd1 など）
const IS_LOCAL_DEV = process.env.NOW_REGION === 'dev1';

function testAllowlist() {
  const raw = process.env.NOTIFICATIONS_TEST_ALLOWLIST || '';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

// 開発サーバーでは、読み込んだときに許可リストの人数を記録に出す（作る前に、許可リストが効いているかを確かめるため）
if (IS_LOCAL_DEV) {
  console.log(`notifications: ローカルの開発サーバー。テストの許可リスト ${testAllowlist().size}人（0人ならお知らせは作らない）`);
}

// ===================== 文の組み立て =====================

function truncate(text, max) {
  const chars = [...String(text || '')];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

// 活動内容の1行目（題名に使う）
function firstLine(text, max = 40) {
  return truncate(String(text || '').split('\n')[0].trim(), max);
}

// "2026-10-16" → "10/16（金）"（曜日は端末に左右されないよう UTC で計算する）
function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}（${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

// 時刻が空なら「終日」、終了時刻があれば「10:00〜12:00」
function formatTimeRange(time, endTime) {
  if (!time) return '終日';
  const start = time.slice(0, 5);
  return endTime ? `${start}〜${endTime.slice(0, 5)}` : start;
}

function joinParts(parts) {
  return parts.filter(Boolean).join(' ・ ');
}

// ===================== 届く人 =====================

// 支部の範囲の有効な人（県連なら、その県連の全支部と県連）
async function branchRecipientIds(supabase, branch) {
  let branches = [branch];
  const region = REGION_OF_HQ[branch];
  if (region) {
    const { data, error } = await supabase.from('branch_regions').select('branch').eq('region', region);
    if (error) throw error;
    branches = (data || []).map((row) => row.branch);
  }
  const { data, error } = await supabase.from('app_users').select('id').eq('status', 'active').in('branch', branches);
  if (error) throw error;
  return (data || []).map((row) => row.id);
}

// ブラインドの調整の関係者（作成者・回答した人・代理登録した人）のうち、有効な人。管理者は足さない
async function blindMemberIds(supabase, coordination) {
  const ids = new Set();
  if (coordination.created_by_user_id) ids.add(coordination.created_by_user_id);
  const { data: responses, error } = await supabase
    .from('coordination_responses')
    .select('participant_user_id, registered_by_user_id')
    .eq('coordination_id', coordination.id);
  if (error) throw error;
  for (const r of responses || []) {
    if (r.participant_user_id) ids.add(r.participant_user_id);
    if (r.registered_by_user_id) ids.add(r.registered_by_user_id);
  }
  if (ids.size === 0) return [];
  const { data, error: userError } = await supabase.from('app_users').select('id').eq('status', 'active').in('id', [...ids]);
  if (userError) throw userError;
  return (data || []).map((row) => row.id);
}

// その予定に「参加」で登録している本人（participant_user_id がある行だけ。代理登録・移行前の行は届けられない）
async function goingParticipantIds(supabase, eventId) {
  const { data, error } = await supabase
    .from('participants')
    .select('participant_user_id')
    .eq('event_id', eventId)
    .eq('status', 'going')
    .not('participant_user_id', 'is', null);
  if (error) throw error;
  return (data || []).map((row) => row.participant_user_id);
}

// ===================== 作る =====================

async function enabledIds(supabase, userIds, kind) {
  if (userIds.length === 0) return [];
  const column = SETTING_OF_KIND[kind];
  const { data, error } = await supabase.from('notification_settings').select(`user_id, ${column}`).in('user_id', userIds);
  if (error) throw error;
  const off = new Set((data || []).filter((row) => row[column] === false).map((row) => row.user_id));
  return userIds.filter((id) => !off.has(id));
}

// 許可リストがあれば、その人だけに絞る。開発サーバーで許可リストが空なら、だれにも作らない
function applyTestAllowlist(ids) {
  const allow = testAllowlist();
  if (allow.size === 0) return IS_LOCAL_DEV ? [] : ids;
  return ids.filter((id) => allow.has(id));
}

// お知らせの行を作る。同じ人・同じ dedupe_key の行がすでにあれば作らない。返り値: 作ろうとした人数
async function createNotifications(supabase, { userIds, excludeUserId, kind, title, body, url, eventId, coordinationId, dedupeKey }) {
  const unique = [...new Set(userIds)].filter((id) => id && id !== excludeUserId);
  const enabled = await enabledIds(supabase, unique, kind);
  const targets = applyTestAllowlist(enabled);
  if (IS_LOCAL_DEV || testAllowlist().size > 0) {
    console.log(`notifications(${kind}): 届く人 ${enabled.length}人 → テストの許可リストで ${targets.length}人`);
  }
  const rows = targets.map((userId) => ({
    user_id: userId,
    kind,
    title: truncate(title, TITLE_MAX_LENGTH),
    body: truncate(body, BODY_MAX_LENGTH),
    url: url || null,
    event_id: eventId || null,
    coordination_id: coordinationId || null,
    dedupe_key: dedupeKey,
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error } = await supabase
      .from('notifications')
      .upsert(rows.slice(i, i + INSERT_CHUNK), { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true });
    if (error) throw error;
  }
  return targets.length;
}

// ② 予定の立ち上げ（決定で作られた予定には呼ばない。④だけにする）
async function notifyEventCreated(supabase, event, actorId) {
  return createNotifications(supabase, {
    userIds: await branchRecipientIds(supabase, event.branch),
    excludeUserId: actorId,
    kind: 'event_created',
    title: `【${event.branch}】新しい予定：${firstLine(event.content)}`,
    body: joinParts([
      `${formatDate(event.date)} ${formatTimeRange(event.time, event.end_time)}`,
      event.category,
      `場所：${event.place}`,
    ]),
    url: `index.html?event=${event.id}`,
    eventId: event.id,
    dedupeKey: `event_created:${event.id}`,
  });
}

// ③ 日程調整の立ち上げ（ブラインドは通知しない。範囲付きでも支部の範囲の全員に届け、文に範囲を書く）
async function notifyCoordinationCreated(supabase, coordination, candidates, actorId) {
  if (coordination.is_blind) return 0;
  const dates = (candidates || []).map((c) => c.date).filter(Boolean).sort();
  const range = dates.length > 0 ? `（${formatDate(dates[0])}〜${formatDate(dates[dates.length - 1])}）` : '';
  return createNotifications(supabase, {
    userIds: await branchRecipientIds(supabase, coordination.branch),
    excludeUserId: actorId,
    kind: 'coordination_created',
    title: `【${coordination.branch}】日程調整：${truncate(coordination.title, 40)}`,
    body: joinParts([
      `候補${dates.length}件${range}`,
      coordination.audience ? `範囲：${coordination.audience}` : '',
      coordination.reply_deadline ? `回答締切 ${formatDate(coordination.reply_deadline)}` : '',
    ]),
    url: `coordination.html?id=${coordination.id}`,
    coordinationId: coordination.id,
    dedupeKey: `coordination_created:${coordination.id}`,
  });
}

// ④ 日程調整の決定（通常は支部の範囲の人、ブラインドは作成者・回答した人・代理登録した人だけ。スケジュールに載せても同じ）
async function notifyCoordinationDecided(supabase, coordinationId, actorId) {
  const { data: c, error } = await supabase
    .from('coordinations')
    .select(
      'id, branch, title, is_blind, status, created_by_user_id, decided_at, decided_event_id, decided_candidate_id, ' +
        'coordination_candidates!coordination_candidates_coordination_id_fkey(id, date, time), ' +
        'decided_event:events!coordinations_decided_event_id_fkey(date, time, end_time)'
    )
    .eq('id', coordinationId)
    .maybeSingle();
  if (error) throw error;
  if (!c || c.status !== 'decided') return 0; // 決定の直後に取り消された等

  const event = c.decided_event_id ? c.decided_event : null;
  const candidate = (c.coordination_candidates || []).find((x) => x.id === c.decided_candidate_id);
  const date = event ? event.date : candidate && candidate.date;
  const timeText = event ? formatTimeRange(event.time, event.end_time) : formatTimeRange(candidate && candidate.time, null);
  return createNotifications(supabase, {
    userIds: c.is_blind ? await blindMemberIds(supabase, c) : await branchRecipientIds(supabase, c.branch),
    excludeUserId: actorId,
    kind: 'coordination_decided',
    title: `【${c.branch}】日程が決まりました：${truncate(c.title, 40)}`,
    body: joinParts([`${formatDate(date)} ${timeText}に決定`, event ? '' : 'スケジュールには載せていません']),
    // ブラインドでも ?t=（トークン）は入れない。?id= は見てよい人だけが開ける
    url: event ? `index.html?event=${c.decided_event_id}` : `coordination.html?id=${c.id}`,
    eventId: c.decided_event_id,
    coordinationId: c.id,
    dedupeKey: `coordination_decided:${c.id}:${c.decided_at}`,
  });
}

// ⑤ 参加した予定の変更（日付・時刻・終了時刻・場所が変わったときだけ）
//   before: 更新前の予定（DBから読んだ行）、after: 更新後の予定（update().select() の行）
async function notifyEventChanged(supabase, before, after, actorId) {
  const changed = CHANGE_FIELDS.filter((key) => (before[key] || null) !== (after[key] || null));
  if (changed.length === 0) return 0;
  const parts = [];
  if (changed.some((key) => key !== 'place')) {
    parts.push(
      `日時：${formatDate(before.date)} ${formatTimeRange(before.time, before.end_time)} → ` +
        `${formatDate(after.date)} ${formatTimeRange(after.time, after.end_time)}`
    );
  }
  if (changed.includes('place')) parts.push(`場所：${before.place} → ${after.place}`);
  return createNotifications(supabase, {
    userIds: await goingParticipantIds(supabase, after.id),
    excludeUserId: actorId,
    kind: 'event_changed',
    title: `【${after.branch}】参加予定の変更：${firstLine(after.content)}`,
    body: joinParts(parts),
    url: `index.html?event=${after.id}`,
    eventId: after.id,
    dedupeKey: `event_changed:${after.id}:${Date.now()}`,
  });
}

// ⑤ 参加した予定の削除。送り先（participantIds）は、削除の前に goingParticipantIds で読んでおく
async function notifyEventDeleted(supabase, event, participantIds, actorId) {
  return createNotifications(supabase, {
    userIds: participantIds,
    excludeUserId: actorId,
    kind: 'event_deleted',
    title: `【${event.branch}】参加予定が削除されました：${firstLine(event.content)}`,
    body: joinParts([`${formatDate(event.date)} ${formatTimeRange(event.time, event.end_time)}`, `場所：${event.place}`]),
    url: null,
    eventId: event.id,
    dedupeKey: `event_deleted:${event.id}`,
  });
}

// お知らせを作る処理を包む。失敗しても投げずに記録だけ（元の操作は成功のまま）
async function notifySafely(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`notifications(${label}) failed:`, err);
  }
}

module.exports = {
  branchRecipientIds,
  blindMemberIds,
  goingParticipantIds,
  notifyEventCreated,
  notifyCoordinationCreated,
  notifyCoordinationDecided,
  notifyEventChanged,
  notifyEventDeleted,
  notifySafely,
};
