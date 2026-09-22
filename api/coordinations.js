const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES } = require('./_lib/branches');

const MAX_CANDIDATES = 30;

// 生のDBエラーをクライアントに返さないための日本語メッセージ変換
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

// POST /api/coordinations : 日程調整の新規作成（一般ユーザー・管理者どちらも可）
//   body: { branch, title, place, content, created_by, reply_deadline?, candidates: [{date, time?}], password }
//   coordinations 1行 + coordination_candidates 複数行をまとめて作成する。
//   候補作成に失敗した場合は、coordinations側も削除して中途半端な行を残さない
//   （1回のAPI呼び出しで2テーブルへの書き込みが必要だが、DB関数は使わず
//   コンペンセーティングアクション＝失敗時の後始末で対応している）
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

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
    normalizedCandidates.push({ date, time: time || null });
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
};
