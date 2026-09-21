const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');

const STATUSES = ['going', 'not_going'];
const COMMENT_MAX_LENGTH = 200;

// 生のDBエラーをクライアントに返さないための日本語メッセージ変換
function joinErrorResponse(error) {
  if (error.code === '23503') {
    return { status: 404, message: '指定された予定が見つかりません' };
  }
  if (error.code === '22P02') {
    return { status: 400, message: '予定IDの形式が正しくありません' };
  }
  if (error.code === '23514') {
    return { status: 400, message: '入力内容が正しくありません' };
  }
  console.error('participants upsert failed:', error);
  return { status: 500, message: '参加登録に失敗しました。時間をおいて再度お試しください' };
}

// POST /api/participants   : 予定への参加登録
//   body: { event_id, participant_name, status?, comment?, password }
//   同じ event_id + participant_name が既にあれば新規作成せず status / comment を更新する（upsert）
// DELETE /api/participants : 予定への参加取り消し（自分の表示名の参加のみ）
module.exports = async (req, res) => {
  const { event_id, participant_name, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  if (!event_id || !participant_name) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }

  const supabase = getSupabaseClient();

  if (req.method === 'POST') {
    const { status, comment } = req.body;

    if (typeof event_id !== 'string' || typeof participant_name !== 'string') {
      return sendJson(res, 400, { error: '入力内容が正しくありません' });
    }

    // 前後の半角・全角スペースを除去（String#trim は U+3000 も対象）
    const name = participant_name.trim();
    if (!name) {
      return sendJson(res, 400, { error: '参加者名を入力してください' });
    }

    if (status !== undefined && status !== null && !STATUSES.includes(status)) {
      return sendJson(res, 400, { error: '参加区分は「参加」または「不参加」を指定してください' });
    }

    // trimmedComment: undefined=未指定（既存コメントは変更しない） / null=コメントなし / string=コメント
    let trimmedComment;
    if (comment !== undefined) {
      if (comment !== null && typeof comment !== 'string') {
        return sendJson(res, 400, { error: 'コメントの形式が正しくありません' });
      }
      trimmedComment = (comment || '').trim() || null;
      // DBのchar_length（文字数）に合わせてコードポイント単位で数える（絵文字等で誤判定しない）
      if (trimmedComment && [...trimmedComment].length > COMMENT_MAX_LENGTH) {
        return sendJson(res, 400, { error: `コメントは${COMMENT_MAX_LENGTH}文字以内で入力してください` });
      }
    }

    // 指定されたキーだけをpayloadに入れる。ON CONFLICT DO UPDATE の更新対象はpayloadの列のみなので、
    // id / created_at（および未指定の status / comment）は既存行のまま変わらない
    const row = { event_id, participant_name: name };
    if (status) row.status = status;
    if (trimmedComment !== undefined) row.comment = trimmedComment;

    const { data, error } = await supabase
      .from('participants')
      .upsert(row, { onConflict: 'event_id,participant_name' })
      .select()
      .single();

    if (error) {
      const { status: httpStatus, message } = joinErrorResponse(error);
      return sendJson(res, httpStatus, { error: message });
    }
    return sendJson(res, 201, data);
  }

  if (req.method === 'DELETE') {
    const { error } = await supabase
      .from('participants')
      .delete()
      .eq('event_id', event_id)
      .eq('participant_name', participant_name);

    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['POST', 'DELETE']);
};
