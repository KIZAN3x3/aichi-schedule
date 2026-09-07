const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { SHARED_OWNER_BRANCHES } = require('./_lib/branches');

const TYPES = ['events', 'equipment', 'participants', 'history'];
const BOM = String.fromCharCode(0xFEFF);

// CSV1フィールドのエスケープ。カンマ／ダブルクォート／改行を含む場合は"..."で囲み、
// 値中の"は""に二重化する。null/undefinedは空文字。
function escapeCsvField(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(headers, rows) {
  const lines = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  // 先頭にUTF-8 BOMを付与（Excelでの文字化け防止）
  return BOM + lines.join('\r\n');
}

// timestamptz値を日本時間の 'YYYY-MM-DD HH:mm' 表記に変換する。null/undefinedは空文字。
function formatJstDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function toAsciiFallback(name) {
  return name.replace(/[^\x20-\x7e]/g, '_');
}

function buildContentDisposition(filename) {
  const ascii = toAsciiFallback(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function fetchEvents(supabase, { from, to, branch }) {
  let query = supabase
    .from('events')
    .select('branch,date,time,end_time,place,content,poster_name,category,finished_at,created_at')
    .order('date', { ascending: true })
    .order('time', { ascending: true });
  if (from) query = query.gte('date', from);
  if (to) query = query.lte('date', to);
  if (branch) query = query.eq('branch', branch);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const headers = ['支部', '日付', '開始時刻', '終了時刻', '場所', '内容', '投稿者', 'カテゴリ', '終了日時', '投稿日時'];
  const rows = (data || []).map((r) => [
    r.branch,
    r.date,
    r.time,
    r.end_time,
    r.place,
    r.content,
    r.poster_name,
    r.category,
    formatJstDateTime(r.finished_at),
    formatJstDateTime(r.created_at),
  ]);
  return { headers, rows, label: '予定' };
}

async function fetchEquipment(supabase, { branch }) {
  let query = supabase
    .from('equipment')
    .select('item_name,management_number,location,memo,owner_branch,owner_person,is_shared,quantity,is_countable,updated_by,updated_at')
    .order('item_name', { ascending: true });
  if (branch) {
    // 指定支部 or 全体共有(西県連/東県連)は必ず含める
    const sharedList = SHARED_OWNER_BRANCHES.join(',');
    query = query.or(`owner_branch.eq.${branch},owner_branch.in.(${sharedList})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const headers = ['品目名', '管理番号', '保管場所', 'メモ', '所有', '担当者', '共有', '数量', '数量変動あり', '最終更新者', '更新日時'];
  const rows = (data || []).map((r) => [
    r.item_name,
    r.management_number,
    r.location,
    r.memo,
    r.owner_branch,
    r.owner_person,
    r.is_shared ? '○' : '',
    r.quantity,
    r.is_countable ? '○' : '',
    r.updated_by,
    formatJstDateTime(r.updated_at),
  ]);
  return { headers, rows, label: '備品一覧' };
}

async function fetchParticipants(supabase, { from, to, branch }) {
  let query = supabase
    .from('participants')
    .select('participant_name,created_at,events!inner(branch,date,time,place,content)')
    .order('created_at', { ascending: true });
  if (from) query = query.gte('events.date', from);
  if (to) query = query.lte('events.date', to);
  if (branch) query = query.eq('events.branch', branch);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const headers = ['支部', '予定日', '開始時刻', '場所', '活動内容', '参加者名', '参加登録日時'];
  const rows = (data || []).map((r) => [
    r.events?.branch,
    r.events?.date,
    r.events?.time,
    r.events?.place,
    r.events?.content,
    r.participant_name,
    formatJstDateTime(r.created_at),
  ]);
  return { headers, rows, label: '参加者リスト' };
}

async function fetchHistory(supabase, { from, to, branch }) {
  let query = supabase
    .from('equipment_history')
    .select('location,moved_by,moved_at,equipment!inner(item_name,owner_branch)')
    .order('moved_at', { ascending: true });
  if (from) query = query.gte('moved_at', `${from}T00:00:00+09:00`);
  if (to) query = query.lte('moved_at', `${to}T23:59:59.999+09:00`);
  if (branch) query = query.eq('equipment.owner_branch', branch);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const headers = ['品目名', '所有', '保管場所', '更新者', '更新日時'];
  const rows = (data || []).map((r) => [
    r.equipment?.item_name,
    r.equipment?.owner_branch,
    r.location,
    r.moved_by,
    formatJstDateTime(r.moved_at),
  ]);
  return { headers, rows, label: '在庫チェック履歴' };
}

// POST /api/export-csv { type: events|equipment|participants|history, from, to, branch, password }
// マスター管理者のみ。読み取り専用（SELECTのみ）でCSVを生成して返す。
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { type, from, to, branch, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  if (role !== 'admin') {
    return sendJson(res, 403, { error: 'CSV出力はマスター管理者のみ可能です' });
  }
  if (!TYPES.includes(type)) {
    return sendJson(res, 400, { error: 'typeが不正です' });
  }

  const supabase = getSupabaseClient();

  let result;
  try {
    if (type === 'events') {
      result = await fetchEvents(supabase, { from, to, branch });
    } else if (type === 'equipment') {
      result = await fetchEquipment(supabase, { branch });
    } else if (type === 'participants') {
      result = await fetchParticipants(supabase, { from, to, branch });
    } else {
      result = await fetchHistory(supabase, { from, to, branch });
    }
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }

  const csv = buildCsv(result.headers, result.rows);
  const period = type === 'equipment' ? '' : `_${(from || '').replace(/-/g, '')}-${(to || '').replace(/-/g, '')}`;
  const filename = `${result.label}${period}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', buildContentDisposition(filename));
  res.status(200).send(csv);
};
