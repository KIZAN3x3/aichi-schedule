const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');

const STATUSES = ['going', 'not_going'];
const COMMENT_MAX_LENGTH = 200;
const REGISTERED_BY_MAX_LENGTH = 50;

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
  console.error('participants write failed:', error);
  return { status: 500, message: '参加登録に失敗しました。時間をおいて再度お試しください' };
}

// POST /api/participants   : 予定への参加登録
//   body: { event_id, participant_name, status?, comment?, registered_by?, password }
//   同じ event_id + participant_name が既にあれば新規作成せず status / comment を更新する。
//   ただし更新できるのは 本人(registered_by === participant_name) または 最初の登録者(既存行のregistered_by) のみ。
//   それ以外は409。registered_by は新規作成時だけ保存し、更新では変更しない。
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
    const { status, comment, registered_by } = req.body;

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

    // registered_by: 未指定（registered_by を送らない現行フロント）は本人登録として participant_name を採用。
    // 明示的に空文字・空白のみ・文字列以外を送った場合は400
    let registeredBy = name;
    if (registered_by !== undefined && registered_by !== null) {
      if (typeof registered_by !== 'string' || !registered_by.trim()) {
        return sendJson(res, 400, { error: '登録者名を入力してください' });
      }
      registeredBy = registered_by.trim();
      if ([...registeredBy].length > REGISTERED_BY_MAX_LENGTH) {
        return sendJson(res, 400, { error: `登録者名は${REGISTERED_BY_MAX_LENGTH}文字以内で入力してください` });
      }
    }

    // 更新する項目。指定されたキーだけを入れる（id / created_at / registered_by は更新しない）
    const fields = {};
    if (status) fields.status = status;
    if (trimmedComment !== undefined) fields.comment = trimmedComment;

    // 更新対象の絞り込み: 同じ予定・同じ名前の行。本人登録(registeredBy === name)以外は、
    // 既存行の registered_by がリクエストの登録者と一致する場合のみ対象にする（判定をDB側で原子的に行う）
    const restrictToTarget = (query) => {
      let q = query.eq('event_id', event_id).eq('participant_name', name);
      if (registeredBy !== name) {
        q = q.eq('registered_by', registeredBy);
      }
      return q;
    };

    // 最大2回: 新規作成 → 既存(23505)なら条件付き更新。更新対象0行のとき、
    // 直前に行が削除されていた場合に備えて新規作成をやり直す
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const insertResult = await supabase
        .from('participants')
        .insert({ event_id, participant_name: name, registered_by: registeredBy, ...fields })
        .select()
        .single();
      if (!insertResult.error) {
        return sendJson(res, 201, insertResult.data);
      }
      if (insertResult.error.code !== '23505') {
        const { status: httpStatus, message } = joinErrorResponse(insertResult.error);
        return sendJson(res, httpStatus, { error: message });
      }

      const table = supabase.from('participants');
      const updateResult = Object.keys(fields).length > 0
        ? await restrictToTarget(table.update(fields)).select()
        : await restrictToTarget(table.select()); // 更新項目なし（現行フロントの再POST）は現在の行を返すだけ
      if (updateResult.error) {
        const { status: httpStatus, message } = joinErrorResponse(updateResult.error);
        return sendJson(res, httpStatus, { error: message });
      }
      if (updateResult.data.length > 0) {
        return sendJson(res, 201, updateResult.data[0]);
      }
    }
    return sendJson(res, 409, { error: 'その名前は既に登録されています' });
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
