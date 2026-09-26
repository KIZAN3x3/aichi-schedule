const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES } = require('./_lib/branches');

const MAX_CANDIDATES = 30;
const CANDIDATE_NOTE_MAX_LENGTH = 50;
const CATEGORY_MAX_LENGTH = 50;

// Vercel Hobbyプランのサーバーレス関数数上限（12個）を超えないよう、
// 元は3ファイルだった以下のエンドポイントをこの1ファイルにまとめている。
// 「/:id」「/:id/decide」というパス区切りの代わりに、クエリ文字列(?id=&action=)で分岐する。
//   POST   /api/coordinations                     : 新規作成（旧 api/coordinations.js）
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

module.exports = async (req, res) => {
  const { id, action } = req.query;

  if (req.method === 'POST' && !id) {
    return handleCreate(req, res);
  }
  if (req.method === 'POST' && id && action === 'decide') {
    return handleDecide(req, res, id);
  }
  if (req.method === 'DELETE' && id) {
    return handleDelete(req, res, id);
  }
  return methodNotAllowed(res, ['POST', 'DELETE']);
};

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

  const trimmedTitle = typeof title === 'string' ? title.trim() : '';
  const trimmedPlace = typeof place === 'string' ? place.trim() : '';
  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  const trimmedCreatedBy = typeof created_by === 'string' ? created_by.trim() : '';
  if (!trimmedTitle || !trimmedPlace || !trimmedContent || !trimmedCreatedBy) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }

  const trimmedDeadline = typeof reply_deadline === 'string' ? reply_deadline.trim() : '';

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return sendJson(res, 400, { error: '候補日時を1件以上入力してください' });
  }
  if (candidates.length > MAX_CANDIDATES) {
    return sendJson(res, 400, { error: `候補日時は${MAX_CANDIDATES}件以内にしてください` });
  }

  const normalizedCandidates = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const date = typeof candidate?.date === 'string' ? candidate.date.trim() : '';
    if (!date) {
      return sendJson(res, 400, { error: '候補日を入力してください' });
    }
    const time = typeof candidate?.time === 'string' ? candidate.time.trim() : '';
    const key = `${date}|${time}`;
    if (seen.has(key)) {
      return sendJson(res, 400, { error: '同じ日時の候補が重複しています' });
    }
    seen.add(key);

    const note = typeof candidate?.note === 'string' ? candidate.note.trim() : '';
    if ([...note].length > CANDIDATE_NOTE_MAX_LENGTH) {
      return sendJson(res, 400, { error: `候補の補足は${CANDIDATE_NOTE_MAX_LENGTH}文字以内で入力してください` });
    }

    normalizedCandidates.push({ date, time: time || null, note: note || null });
  }

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
