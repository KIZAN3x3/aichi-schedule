const { getSupabaseClient } = require('./_lib/supabase');
const { resolveActor } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { regionResolverFor, canActOnRow } = require('./_lib/permissions');

const STATUSES = ['going', 'not_going'];
const COMMENT_MAX_LENGTH = 200;
const SAME_NAME_MESSAGE = '同じ名前の人がすでに登録しています';
// 移行前（共通パスワードの時期）に同じ名前で登録された参加（ユーザーIDが空欄の行）と重なったとき
const LEGACY_SAME_NAME_MESSAGE =
  'この予定には、同じ名前で共通パスワードから登録された参加がすでにあります。変更・取消は、この支部を管理する管理者に依頼してください';

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

// 参加の行の本人（ユーザーID）。本人登録なら参加者本人、代理登録なら登録した人も本人として扱う
function participantRowOwner(row, branch) {
  return { branch, userIds: [row.participant_user_id, row.registered_by_user_id] };
}

// POST /api/participants   : 予定への参加登録
//   body: { event_id, participant_name, status?, comment? }
//   同じ event_id + participant_name が既にあれば新規作成せず status / comment を更新する。
//   更新できるのは、その行の本人（participant_user_id / registered_by_user_id。IDが空欄の行は管理者だけ）か、
//   その支部を管理できる管理者だけ。それ以外は409。名前・IDの列は新規作成時だけ保存し、更新では変更しない。
//   participant_name が自分の表示名なら本人登録（participant_user_id = 自分）、違えば代理登録
//   （participant_user_id は空欄）。registered_by は表示名、registered_by_user_id は自分（送られた registered_by は使わない）
// DELETE /api/participants : 予定への参加取り消し
//   body: { event_id, participant_name }
//   取り消せるのは、その行の本人（上と同じ判定）か、その支部を管理できる管理者だけ
module.exports = async (req, res) => {
  const { event_id, participant_name } = req.body || {};
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  if (!event_id || !participant_name) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }
  if (typeof event_id !== 'string' || typeof participant_name !== 'string') {
    return sendJson(res, 400, { error: '入力内容が正しくありません' });
  }

  const supabase = getSupabaseClient();

  // 親の予定の支部（管理者の範囲の判定に使う）
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('branch')
    .eq('id', event_id)
    .maybeSingle();
  if (eventError) {
    const { status: httpStatus, message } = joinErrorResponse(eventError);
    return sendJson(res, httpStatus, { error: message });
  }
  if (!event) {
    return sendJson(res, 404, { error: '指定された予定が見つかりません' });
  }
  const regionOf = await regionResolverFor(actor);

  if (req.method === 'POST') {
    const { status, comment } = req.body;

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

    // 登録した人（名前・ID）と、参加者本人のID（表示名と同じなら本人登録、違えば代理登録）
    const registeredBy = actor.user.display_name;
    const registeredByUserId = actor.user.id;
    const participantUserId = name === actor.user.display_name ? actor.user.id : null;

    // 更新する項目。指定されたキーだけを入れる（id / created_at / 名前・IDの列は更新しない）
    const fields = {};
    if (status) fields.status = status;
    if (trimmedComment !== undefined) fields.comment = trimmedComment;

    // 最大2回: 新規作成 → 既存(23505)なら、既存の行の本人か確認して条件付き更新。
    // 更新対象0行のとき、直前に行が削除・変更されていた場合に備えてやり直す
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const insertResult = await supabase
        .from('participants')
        .insert({
          event_id,
          participant_name: name,
          participant_user_id: participantUserId,
          registered_by: registeredBy,
          registered_by_user_id: registeredByUserId,
          ...fields,
        })
        .select()
        .single();
      if (!insertResult.error) {
        return sendJson(res, 201, insertResult.data);
      }
      if (insertResult.error.code !== '23505') {
        const { status: httpStatus, message } = joinErrorResponse(insertResult.error);
        return sendJson(res, httpStatus, { error: message });
      }

      const { data: existing, error: existingError } = await supabase
        .from('participants')
        .select('*')
        .eq('event_id', event_id)
        .eq('participant_name', name)
        .maybeSingle();
      if (existingError) {
        const { status: httpStatus, message } = joinErrorResponse(existingError);
        return sendJson(res, httpStatus, { error: message });
      }
      if (!existing) continue; // 直前に削除された → 新規作成をやり直す

      if (!canActOnRow(actor, participantRowOwner(existing, event.branch), regionOf)) {
        const legacyRow = !existing.participant_user_id && !existing.registered_by_user_id;
        return sendJson(res, 409, { error: legacyRow ? LEGACY_SAME_NAME_MESSAGE : SAME_NAME_MESSAGE });
      }

      // 判定に使った本人のIDが、判定のあとに変わっていないことを条件に更新する
      const hasFields = Object.keys(fields).length > 0;
      let query = hasFields
        ? supabase.from('participants').update(fields)
        : supabase.from('participants').select(); // 更新項目なし（現行フロントの再POST）は現在の行を返すだけ
      query = query.eq('id', existing.id);
      query = existing.participant_user_id
        ? query.eq('participant_user_id', existing.participant_user_id)
        : query.is('participant_user_id', null);
      query = existing.registered_by_user_id
        ? query.eq('registered_by_user_id', existing.registered_by_user_id)
        : query.is('registered_by_user_id', null);
      const updateResult = hasFields ? await query.select() : await query;
      if (updateResult.error) {
        const { status: httpStatus, message } = joinErrorResponse(updateResult.error);
        return sendJson(res, httpStatus, { error: message });
      }
      if (updateResult.data.length > 0) {
        return sendJson(res, 201, updateResult.data[0]);
      }
    }
    return sendJson(res, 409, { error: SAME_NAME_MESSAGE });
  }

  if (req.method === 'DELETE') {
    const { data: existing, error: fetchError } = await supabase
      .from('participants')
      .select('*')
      .eq('event_id', event_id)
      .eq('participant_name', participant_name)
      .maybeSingle();
    if (fetchError) {
      return sendJson(res, 500, { error: fetchError.message });
    }
    if (!existing) {
      return sendJson(res, 404, { error: '参加登録が見つかりません' });
    }
    if (!canActOnRow(actor, participantRowOwner(existing, event.branch), regionOf)) {
      return sendJson(res, 403, { error: 'この参加を取り消せるのは、本人・登録した人か、この支部を管理する管理者だけです' });
    }

    const { error } = await supabase.from('participants').delete().eq('id', existing.id);
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['POST', 'DELETE']);
};
