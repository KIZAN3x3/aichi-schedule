const { getSupabaseClient } = require('./_lib/supabase');
const { resolveActor } = require('./_lib/auth');
const { isGlobalManager, regionResolverFor } = require('./_lib/permissions');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES, SHARED_OWNER_BRANCHES } = require('./_lib/branches');

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

async function fetchEvents(supabase, { from, to, branch, branchesIn }) {
  let query = supabase
    .from('events')
    .select('branch,date,time,end_time,place,content,poster_name,category,finished_at,created_at')
    .order('date', { ascending: true })
    .order('time', { ascending: true });
  if (from) query = query.gte('date', from);
  if (to) query = query.lte('date', to);
  if (branchesIn) query = query.in('branch', branchesIn);
  else if (branch) query = query.eq('branch', branch);

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

async function fetchEquipment(supabase, { branch, branchesIn }) {
  let query = supabase
    .from('equipment')
    .select('item_name,management_number,location,memo,owner_branch,owner_person,is_shared,quantity,is_countable,updated_by,updated_at,created_by,item_kind')
    .order('item_name', { ascending: true });
  if (branchesIn) {
    // 県連管理者: 所有支部が自分の県連内の備品だけ（空欄・「その他」、もう一方の県連の備品は含めない）
    query = query.in('owner_branch', branchesIn);
  } else if (branch) {
    // 指定支部 or 全体共有(西県連/東県連)は必ず含める
    const sharedList = SHARED_OWNER_BRANCHES.join(',');
    query = query.or(`owner_branch.eq.${branch},owner_branch.in.(${sharedList})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const headers = ['品目名', '管理番号', '保管場所', 'メモ', '所有', '担当者', '共有', '数量', '数量変動あり', '最終更新者', '更新日時', '登録者', '種類'];
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
    r.created_by,
    r.item_kind,
  ]);
  return { headers, rows, label: '備品一覧' };
}

const PARTICIPANT_STATUS_LABELS = { going: '参加', not_going: '不参加' };

async function fetchParticipants(supabase, { from, to, branch, branchesIn }) {
  let query = supabase
    .from('participants')
    .select('participant_name,status,comment,registered_by,created_at,events!inner(branch,date,time,place,content)')
    .order('created_at', { ascending: true });
  if (from) query = query.gte('events.date', from);
  if (to) query = query.lte('events.date', to);
  if (branchesIn) query = query.in('events.branch', branchesIn);
  else if (branch) query = query.eq('events.branch', branch);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const headers = ['支部', '予定日', '開始時刻', '場所', '活動内容', '参加者名', '参加状況', 'コメント', '登録者', '参加登録日時'];
  const rows = (data || []).map((r) => [
    r.events?.branch,
    r.events?.date,
    r.events?.time,
    r.events?.place,
    r.events?.content,
    r.participant_name,
    PARTICIPANT_STATUS_LABELS[r.status] ?? r.status,
    r.comment,
    r.registered_by,
    formatJstDateTime(r.created_at),
  ]);
  return { headers, rows, label: '参加者リスト' };
}

async function fetchHistory(supabase, { from, to, branch, branchesIn }) {
  let query = supabase
    .from('equipment_history')
    .select('location,moved_by,moved_at,equipment!inner(item_name,owner_branch)')
    .order('moved_at', { ascending: true });
  if (from) query = query.gte('moved_at', `${from}T00:00:00+09:00`);
  if (to) query = query.lte('moved_at', `${to}T23:59:59.999+09:00`);
  if (branchesIn) query = query.in('equipment.owner_branch', branchesIn);
  else if (branch) query = query.eq('equipment.owner_branch', branch);

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
// 読み取り専用（SELECTのみ）でCSVを生成して返す。
//   ・共通パスワードの管理者・システム管理者: 全支部（branch を省略すると全支部）
//   ・県連管理者: 自分の県連の支部の分だけ。branch を省略すると自分の県連の全支部、県連の外の支部を指定したら403。
//     備品・在庫チェック履歴は、所有支部が自分の県連内のものだけ（branch 指定時はその支部と自分の県連の県連所有分）
//   ・それ以外（支部管理者・一般）: 不可
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { type, from, to, branch, password } = req.body || {};
  const auth = await resolveActor(req, password);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  if (!TYPES.includes(type)) {
    return sendJson(res, 400, { error: 'typeが不正です' });
  }

  // 県連管理者は、自分の県連の支部に絞る（branchesIn）
  let branchesIn = null;
  if (!isGlobalManager(actor)) {
    if (!(actor.via === 'google' && actor.kind === 'region')) {
      return sendJson(res, 403, {
        error: actor.via === 'google'
          ? 'CSV出力は、システム管理者と県連管理者だけが使えます'
          : 'CSV出力はマスター管理者のみ可能です',
      });
    }
    const regionOf = await regionResolverFor(actor);
    const myRegion = regionOf(actor.user.branch);
    const regionBranches = BRANCHES.filter((b) => myRegion && regionOf(b) === myRegion);
    if (branch && !regionBranches.includes(branch)) {
      return sendJson(res, 403, { error: 'CSV出力は、自分の県連の支部だけ選べます' });
    }
    if (!branch) {
      branchesIn = regionBranches;
    } else if (type === 'equipment') {
      // 指定支部＋自分の県連の県連所有分（全体共有）。もう一方の県連の県連所有分は含めない
      branchesIn = [branch, ...regionBranches.filter((b) => SHARED_OWNER_BRANCHES.includes(b))];
    } else {
      branchesIn = [branch];
    }
  }

  const supabase = getSupabaseClient();

  let result;
  try {
    if (type === 'events') {
      result = await fetchEvents(supabase, { from, to, branch, branchesIn });
    } else if (type === 'equipment') {
      result = await fetchEquipment(supabase, { branch, branchesIn });
    } else if (type === 'participants') {
      result = await fetchParticipants(supabase, { from, to, branch, branchesIn });
    } else {
      result = await fetchHistory(supabase, { from, to, branch, branchesIn });
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
