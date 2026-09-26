const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES } = require('./_lib/branches');

const MAX_CANDIDATES = 30;
// 候補日の最低件数と、その不足時の文言（js/coordination.js の MIN_CANDIDATES / 文言と完全に一致させること）
const MIN_CANDIDATES = 2;
const MIN_CANDIDATES_MESSAGE =
  '日程調整は候補日を2つ以上入れてください。日にちが決まっている場合は、スケジュール画面から予定として登録してください。';
const CANDIDATE_NOTE_MAX_LENGTH = 50;
const CATEGORY_MAX_LENGTH = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Vercel Hobbyプランのサーバーレス関数数上限（12個）を超えないよう、
// 元は3ファイルだった以下のエンドポイントをこの1ファイルにまとめている。
// 「/:id」「/:id/decide」というパス区切りの代わりに、クエリ文字列(?id=&action=)で分岐する。
//   POST   /api/coordinations                     : 新規作成（旧 api/coordinations.js）
//   PUT    /api/coordinations?id=xxx               : 編集（調整中のときだけ。DB関数update_coordination）
//   DELETE /api/coordinations?id=xxx               : 削除（旧 api/coordinations/[id].js）
//   POST   /api/coordinations?id=xxx&action=decide : 決定（旧 api/coordinations/[id]/decide.js）
// GET /api/coordinations/:id（1件取得）は、フロントのどこからも呼ばれていなかったため統合時に廃止した
// （専用URL用の取得は js/coordination.js が anon key で直接Supabaseをselectしている）。

// 生のDBエラーをクライアントに返さないための日本語メッセージ変換（作成・削除用）
function coordinationErrorResponse(error) {
  if (error.code === '22007' || error.code === '22008') {
    return { status: 400, message: '日付または時刻の形式が正しくありません' };
  }
  if (error.code === '23505') {
    return { status: 400, message: '同じ日時の候補が重複しています' };
  }
  console.error('coordinations write failed:', error);
  return { status: 500, message: '日程調整の作成に失敗しました。時間をおいて再度お試しください' };
}

// DB関数decide_coordinationが投げる想定内のエラー（P0001〜P0003）を日本語のまま伝える。
// それ以外（想定外のDBエラー）は汎用メッセージにする
function decideErrorResponse(error) {
  if (error.code === 'P0001') {
    return { status: 409, message: error.message };
  }
  if (error.code === 'P0002' || error.code === 'P0003') {
    return { status: 400, message: error.message };
  }
  if (error.code === '22007' || error.code === '22008') {
    return { status: 400, message: '時刻の形式が正しくありません' };
  }
  console.error('decide_coordination failed:', error);
  return { status: 500, message: '決定処理に失敗しました。時間をおいて再度お試しください' };
}

// DB関数update_coordinationが投げる想定内のエラーを日本語のまま伝える。
//   P0001: 決定済み・見つからない（409）／P0003: 入力の不備（400）／P0004: ほかの人の編集と衝突（409）
function updateErrorResponse(error) {
  if (error.code === 'P0001' || error.code === 'P0004') {
    return { status: 409, message: error.message };
  }
  if (error.code === 'P0003') {
    return { status: 400, message: error.message };
  }
  if (error.code === '22007' || error.code === '22008') {
    return { status: 400, message: '日付または時刻の形式が正しくありません' };
  }
  if (error.code === '22P02') {
    return { status: 400, message: '入力内容の形式が正しくありません' };
  }
  console.error('update_coordination failed:', error);
  return { status: 500, message: '日程調整の保存に失敗しました。時間をおいて再度お試しください' };
}

module.exports = async (req, res) => {
  const { id, action } = req.query;

  if (req.method === 'POST' && !id) {
    return handleCreate(req, res);
  }
  if (req.method === 'POST' && id && action === 'decide') {
    return handleDecide(req, res, id);
  }
  if (req.method === 'PUT' && id) {
    return handleUpdate(req, res, id);
  }
  if (req.method === 'DELETE' && id) {
    return handleDelete(req, res, id);
  }
  return methodNotAllowed(res, ['POST', 'PUT', 'DELETE']);
};

// 題名・場所・内容・回答締切の入力チェック（作成と編集で共通）
function validateCoordinationFields({ title, place, content, reply_deadline }) {
  const trimmedTitle = typeof title === 'string' ? title.trim() : '';
  const trimmedPlace = typeof place === 'string' ? place.trim() : '';
  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  if (!trimmedTitle || !trimmedPlace || !trimmedContent) {
    return { error: '必須項目が不足しています' };
  }
  const trimmedDeadline = typeof reply_deadline === 'string' ? reply_deadline.trim() : '';
  return { trimmedTitle, trimmedPlace, trimmedContent, trimmedDeadline };
}

// 候補日時の入力チェック（作成と編集で共通）。
//   ・候補は2つ以上（日付が入った候補を「日付|時刻」でまとめて数える。補足だけ違う同じ日時は1件）
//   ・30件以内、日付は必須、同じ日時の重複なし、補足は50文字以内
//   ・時刻は「HH:MM」にそろえて比べる（編集時はDBの「HH:MM:SS」が来ることもあるため）
//   allowId: 編集時だけ、既存の候補のid（uuid）を受け付ける
function validateCandidates(candidates, { allowId }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { error: MIN_CANDIDATES_MESSAGE };
  }
  if (candidates.length > MAX_CANDIDATES) {
    return { error: `候補日時は${MAX_CANDIDATES}件以内にしてください` };
  }
  const readDate = (c) => (typeof c?.date === 'string' ? c.date.trim() : '');
  const readTime = (c) => (typeof c?.time === 'string' ? c.time.trim().slice(0, 5) : '');

  // 下の1件ずつのチェックより先に行い、同じ候補を2つ入れただけの場合も「2つ以上」の文言を返す
  const uniqueKeys = new Set();
  for (const candidate of candidates) {
    const date = readDate(candidate);
    if (!date) continue;
    uniqueKeys.add(`${date}|${readTime(candidate)}`);
  }
  if (uniqueKeys.size < MIN_CANDIDATES) {
    return { error: MIN_CANDIDATES_MESSAGE };
  }

  const normalized = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const date = readDate(candidate);
    if (!date) {
      return { error: '候補日を入力してください' };
    }
    const time = readTime(candidate);
    const key = `${date}|${time}`;
    if (seen.has(key)) {
      return { error: '同じ日時の候補が重複しています' };
    }
    seen.add(key);

    const note = typeof candidate?.note === 'string' ? candidate.note.trim() : '';
    if ([...note].length > CANDIDATE_NOTE_MAX_LENGTH) {
      return { error: `候補の補足は${CANDIDATE_NOTE_MAX_LENGTH}文字以内で入力してください` };
    }

    const item = { date, time: time || null, note: note || null };
    if (allowId && candidate?.id) {
      if (typeof candidate.id !== 'string' || !UUID_PATTERN.test(candidate.id)) {
        return { error: '候補の指定が正しくありません' };
      }
      item.id = candidate.id;
    }
    normalized.push(item);
  }
  return { normalized };
}

// POST /api/coordinations : 日程調整の新規作成（一般ユーザー・管理者どちらも可）
//   body: { branch, title, place, content, created_by, reply_deadline?,
//           candidates: [{date, time?, note?}], password }
//   coordinations 1行 + coordination_candidates 複数行をまとめて作成する。
//   候補作成に失敗した場合は、coordinations側も削除して中途半端な行を残さない
//   （1回のAPI呼び出しで2テーブルへの書き込みが必要だが、DB関数は使わず
//   コンペンセーティングアクション＝失敗時の後始末で対応している）
async function handleCreate(req, res) {
  const { branch, title, place, content, created_by, reply_deadline, candidates, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  if (!BRANCHES.includes(branch)) {
    return sendJson(res, 400, { error: '支部が不正です' });
  }

  const trimmedCreatedBy = typeof created_by === 'string' ? created_by.trim() : '';
  const fields = validateCoordinationFields({ title, place, content, reply_deadline });
  if (fields.error || !trimmedCreatedBy) {
    return sendJson(res, 400, { error: fields.error || '必須項目が不足しています' });
  }
  const { trimmedTitle, trimmedPlace, trimmedContent, trimmedDeadline } = fields;

  const candidateResult = validateCandidates(candidates, { allowId: false });
  if (candidateResult.error) {
    return sendJson(res, 400, { error: candidateResult.error });
  }
  const normalizedCandidates = candidateResult.normalized;

  const supabase = getSupabaseClient();

  const { data: coordination, error: coordinationError } = await supabase
    .from('coordinations')
    .insert({
      branch,
      title: trimmedTitle,
      place: trimmedPlace,
      content: trimmedContent,
      created_by: trimmedCreatedBy,
      reply_deadline: trimmedDeadline || null,
    })
    .select()
    .single();

  if (coordinationError) {
    const { status, message } = coordinationErrorResponse(coordinationError);
    return sendJson(res, status, { error: message });
  }

  const { data: candidateRows, error: candidatesError } = await supabase
    .from('coordination_candidates')
    .insert(
      normalizedCandidates.map((c, index) => ({
        coordination_id: coordination.id,
        date: c.date,
        time: c.time,
        note: c.note,
        sort_order: index,
      }))
    )
    .select();

  if (candidatesError) {
    // 候補の作成に失敗した場合、候補ゼロのcoordinationsだけが残ると使い物にならないため、
    // 作成済みのcoordinations行を削除して後始末する（DB関数を使わない代わりの安全策）
    const { error: cleanupError } = await supabase.from('coordinations').delete().eq('id', coordination.id);
    if (cleanupError) {
      console.error('coordinations cleanup after candidates failure failed:', cleanupError);
    }
    const { status, message } = coordinationErrorResponse(candidatesError);
    return sendJson(res, status, { error: message });
  }

  return sendJson(res, 201, { ...coordination, coordination_candidates: candidateRows });
}

// PUT /api/coordinations?id=xxx : 日程調整の編集（作成者本人 or 管理者のみ。調整中のときだけ）
//   body: { title, place, content, reply_deadline?, candidates: [{id?, date, time?, note?}], created_by, password }
//   created_by は操作する人の名前（作成者本人かどうかの判定に使う。作成者名そのものは変更しない）。
//   候補は、既存の候補ならidを付けて渡す（idの無いものは新規追加、渡されなかった既存の候補は削除）。
//   調整本体と候補の更新は、DB関数 update_coordination が1トランザクションで行う
//   （行ロックにより決定処理と同時には走らない。決定済みならP0001で止まる）
async function handleUpdate(req, res, id) {
  const { title, place, content, reply_deadline, candidates, created_by, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  const operator = typeof created_by === 'string' ? created_by.trim() : '';
  if (!operator) {
    return sendJson(res, 400, { error: 'created_byが必要です' });
  }
  if (!UUID_PATTERN.test(id)) {
    return sendJson(res, 400, { error: 'IDの形式が正しくありません' });
  }

  const supabase = getSupabaseClient();

  const { data: existing, error: fetchError } = await supabase
    .from('coordinations')
    .select('created_by, status')
    .eq('id', id)
    .maybeSingle();
  if (fetchError || !existing) {
    return sendJson(res, 404, { error: '日程調整が見つかりません' });
  }
  if (role !== 'admin' && existing.created_by !== operator) {
    return sendJson(res, 403, { error: '作成者本人のみ編集できます' });
  }
  // 画面で分かりやすい文言を返すための事前チェック。
  // 最終的な判定は、DB関数が行ロックを取ってから行う（この間に決定された場合もP0001で止まる）
  if (existing.status !== 'open') {
    return sendJson(res, 409, { error: '決定済みの日程調整は編集できません' });
  }

  const fields = validateCoordinationFields({ title, place, content, reply_deadline });
  if (fields.error) {
    return sendJson(res, 400, { error: fields.error });
  }
  const candidateResult = validateCandidates(candidates, { allowId: true });
  if (candidateResult.error) {
    return sendJson(res, 400, { error: candidateResult.error });
  }

  const { error } = await supabase.rpc('update_coordination', {
    p_coordination_id: id,
    p_title: fields.trimmedTitle,
    p_place: fields.trimmedPlace,
    p_content: fields.trimmedContent,
    p_reply_deadline: fields.trimmedDeadline || null,
    p_candidates: candidateResult.normalized,
  });
  if (error) {
    const { status, message } = updateErrorResponse(error);
    return sendJson(res, status, { error: message });
  }
  return sendJson(res, 200, { id });
}

// DELETE /api/coordinations?id=xxx : 日程調整の削除（作成者本人 or 管理者のみ）
//   決定済みも削除できる。eventsはcoordinationsを参照していない（参照の向きは
//   coordinations.decided_event_id → events.id の一方向）ため、決定で作られた予定と参加者は残る
async function handleDelete(req, res, id) {
  const { created_by, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  if (!created_by) {
    return sendJson(res, 400, { error: 'created_byが必要です' });
  }

  const supabase = getSupabaseClient();

  const { data: existing, error: fetchError } = await supabase
    .from('coordinations')
    .select('created_by')
    .eq('id', id)
    .single();
  if (fetchError || !existing) {
    return sendJson(res, 404, { error: '日程調整が見つかりません' });
  }
  if (role !== 'admin' && existing.created_by !== created_by) {
    return sendJson(res, 403, { error: '作成者本人のみ削除できます' });
  }

  const { error } = await supabase.from('coordinations').delete().eq('id', id);
  if (error) {
    console.error('coordinations DELETE failed:', error);
    return sendJson(res, 500, { error: '削除に失敗しました。時間をおいて再度お試しください' });
  }
  return sendJson(res, 204, null);
}

// POST /api/coordinations?id=xxx&action=decide : 候補を決定してeventsへ登録（作成者本人 or 管理者のみ）
//   body: { decided_by, candidate_id, place, content, category?, time, end_time?,
//           register_yes?, register_maybe?, password }
//   権限チェックのみここで行い、実際の書き込みはDB関数 decide_coordination に任せる
//   （events作成・participants一括登録・coordinations更新を1トランザクションで行う）
async function handleDecide(req, res, id) {
  const {
    decided_by,
    candidate_id,
    place,
    content,
    category,
    time,
    end_time,
    register_yes,
    register_maybe,
    password,
  } = req.body || {};

  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }

  const trimmedDecidedBy = typeof decided_by === 'string' ? decided_by.trim() : '';
  if (!trimmedDecidedBy) {
    return sendJson(res, 400, { error: '決定操作をした人の名前を入力してください' });
  }
  if (!candidate_id) {
    return sendJson(res, 400, { error: '決定する候補を選択してください' });
  }
  const trimmedPlace = typeof place === 'string' ? place.trim() : '';
  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  if (!trimmedPlace || !trimmedContent) {
    return sendJson(res, 400, { error: '場所と活動内容を入力してください' });
  }
  const trimmedTime = typeof time === 'string' ? time.trim() : '';
  if (!trimmedTime) {
    return sendJson(res, 400, { error: '開始時刻を入力してください' });
  }
  const trimmedEndTime = typeof end_time === 'string' ? end_time.trim() : '';
  if (trimmedEndTime && trimmedEndTime <= trimmedTime) {
    return sendJson(res, 400, { error: '終了時間は開始時間より後にしてください' });
  }
  const trimmedCategory = typeof category === 'string' ? category.trim() : '';
  if (trimmedCategory.length > CATEGORY_MAX_LENGTH) {
    return sendJson(res, 400, { error: `カテゴリは${CATEGORY_MAX_LENGTH}文字以内で入力してください` });
  }
  // 固定カテゴリ外の自由入力も許可する（events.categoryと同じ扱い。候補管理への自動登録は行わない）

  const supabase = getSupabaseClient();

  const { data: existing, error: fetchError } = await supabase
    .from('coordinations')
    .select('created_by')
    .eq('id', id)
    .single();
  if (fetchError || !existing) {
    return sendJson(res, 404, { error: '日程調整が見つかりません' });
  }
  if (role !== 'admin' && existing.created_by !== trimmedDecidedBy) {
    return sendJson(res, 403, { error: '作成者本人または管理者のみ決定できます' });
  }

  const { data: eventId, error } = await supabase.rpc('decide_coordination', {
    p_coordination_id: id,
    p_candidate_id: candidate_id,
    p_decided_by: trimmedDecidedBy,
    p_place: trimmedPlace,
    p_content: trimmedContent,
    p_category: trimmedCategory || null,
    p_time: trimmedTime,
    p_end_time: trimmedEndTime || null,
    p_register_yes: register_yes !== false,
    p_register_maybe: register_maybe === true,
  });

  if (error) {
    const { status, message } = decideErrorResponse(error);
    return sendJson(res, status, { error: message });
  }

  return sendJson(res, 200, { event_id: eventId });
}
