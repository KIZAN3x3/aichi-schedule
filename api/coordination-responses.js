const { getSupabaseClient } = require('./_lib/supabase');
const { resolveActor } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { regionResolverFor, canActOnRow } = require('./_lib/permissions');
const { respondedCoordinationIds, canViewCoordination, coordinationIdByToken } = require('./_lib/coordinationAccess');

const MARKS = ['yes', 'maybe', 'no'];
const COMMENT_MAX_LENGTH = 200;
const SAME_NAME_MESSAGE = '同じ名前の人がすでに回答しています';
// 移行前（共通パスワードの時期）に同じ名前で登録された回答（ユーザーIDが空欄の行）と重なったとき
const LEGACY_SAME_NAME_MESSAGE =
  'この日程調整には、同じ名前で共通パスワードから登録された回答がすでにあります。変更・取消は、この支部を管理する管理者に依頼してください';

// 回答の行の本人（ユーザーID）。本人登録なら回答者本人、代理登録なら登録した人も本人として扱う
function responseRowOwner(row, branch) {
  return { branch, userIds: [row.participant_user_id, row.registered_by_user_id] };
}

// 本人の回答（participant_user_id が自分）を探して、コメントを更新する（段階5 ①・migration 0025）。
// 同じ日程調整に本人の回答は1行だけ（DBの一意の条件）なので、表示名を変えた人も同じ行を更新する。
// 表示名を変えていたら、名前も今の表示名にそろえる（同じ日程調整にその名前の行がほかにあれば、名前は変えずに残す）。
// 返り値: { row }（更新した行。見つからない・直前に消されたときは null）か { error }
async function updateOwnResponse(supabase, { coordinationId, userId, name, comment }) {
  const { data: own, error } = await supabase
    .from('coordination_responses')
    .select('*')
    .eq('coordination_id', coordinationId)
    .eq('participant_user_id', userId)
    .maybeSingle();
  if (error) return { error };
  if (!own) return { row: null };

  const updates = { comment };
  if (own.participant_name !== name) updates.participant_name = name;
  const run = (values) =>
    supabase
      .from('coordination_responses')
      .update(values)
      .eq('id', own.id)
      .eq('participant_user_id', userId)
      .select();
  let result = await run(updates);
  if (result.error && result.error.code === '23505' && updates.participant_name) {
    // その名前は同じ日程調整のほかの行が使っている → 名前は今のまま、コメントだけ更新する
    delete updates.participant_name;
    result = await run(updates);
  }
  if (result.error) return { error: result.error };
  return { row: result.data[0] || null };
}

// 生のDBエラーをクライアントに返さないための日本語メッセージ変換
function responseErrorResponse(error) {
  if (error.code === '23503') {
    return { status: 404, message: '指定された日程調整が見つかりません' };
  }
  if (error.code === '22P02') {
    return { status: 400, message: 'IDの形式が正しくありません' };
  }
  if (error.code === '23514') {
    return { status: 400, message: '入力内容が正しくありません' };
  }
  console.error('coordination-responses write failed:', error);
  return { status: 500, message: '回答の登録に失敗しました。時間をおいて再度お試しください' };
}

// POST /api/coordination-responses   : 日程調整への回答（登録・更新）
//   body: { coordination_id, participant_name, comment?, answers: [{candidate_id, mark}] }
//   本人の回答（participant_name が自分の表示名）は、まず自分のユーザーIDで既存の行を探し、あれば更新する
//   （表示名を変えた人も同じ日程調整に1行だけ。名前も今の表示名にそろえる。段階5 ①）。
//   それ以外は、同じ coordination_id + participant_name が既にあれば新規作成せず更新する。
//   更新できるのは、その行の本人（participant_user_id / registered_by_user_id。IDが空欄の行は管理者だけ）か、
//   その支部を管理できる管理者だけ。それ以外は409。参加者機能(api/participants.js)と同じ考え方。
//   participant_name が自分の表示名なら本人登録（participant_user_id = 自分）、違えば代理登録。
//   registered_by は表示名、registered_by_user_id は自分（送られた registered_by は使わない）
// DELETE /api/coordination-responses : 回答の取り消し（本人・代理登録した人、またはその支部を管理できる管理者）
//   body: { coordination_id, participant_name }
// ブラインドの調整（migration 0023）には、正しいトークン（body.token）を送った人か、見てよい人
// （作成者本人・その支部を管理できる管理者・回答した人。api/_lib/coordinationAccess.js）だけが回答・取消できる。
// それ以外は404（ブラインドの調整があることも伝えない）。
// 登録・編集・取消はどれも、調整中(status='open')のときだけ受け付ける（決定済みは409）。
// ※状態の確認と書き込みの間に決定された場合は、その回答が決定済みの調整に残りうる
//   （数十〜数百ミリ秒の間だけ。データは壊れない。DBトリガーでの厳密な防止は入れていない）
module.exports = async (req, res) => {
  const { coordination_id, participant_name } = req.body || {};
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  if (!coordination_id || !participant_name) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }

  const supabase = getSupabaseClient();

  // 親の日程調整（状態の確認と、管理者の範囲の判定に使う支部）
  let coordination = null;
  let regionOf = null;
  if (req.method === 'POST' || req.method === 'DELETE') {
    const { data, error: coordinationError } = await supabase
      .from('coordinations')
      .select('id, status, branch, is_blind, created_by_user_id')
      .eq('id', coordination_id)
      .maybeSingle();
    coordination = data;
    if (coordinationError) {
      const { status, message } = responseErrorResponse(coordinationError);
      return sendJson(res, status, { error: message });
    }
    if (!coordination) {
      return sendJson(res, 404, { error: '指定された日程調整が見つかりません' });
    }
    regionOf = await regionResolverFor(actor);
    if (coordination.is_blind) {
      let allowed = false;
      try {
        allowed =
          (req.body.token !== undefined && (await coordinationIdByToken(supabase, req.body.token)) === coordination.id) ||
          canViewCoordination(
            actor,
            coordination,
            regionOf,
            await respondedCoordinationIds(supabase, actor.user.id, [coordination.id])
          );
      } catch (err) {
        const { status, message } = responseErrorResponse(err);
        return sendJson(res, status, { error: message });
      }
      if (!allowed) {
        return sendJson(res, 404, { error: '指定された日程調整が見つかりません' });
      }
    }
    if (coordination.status !== 'open') {
      return sendJson(res, 409, { error: 'この日程調整は決定済みのため、回答できません。' });
    }
  }

  if (req.method === 'POST') {
    const { comment, answers } = req.body;

    if (typeof coordination_id !== 'string' || typeof participant_name !== 'string') {
      return sendJson(res, 400, { error: '入力内容が正しくありません' });
    }

    const name = participant_name.trim();
    if (!name) {
      return sendJson(res, 400, { error: '参加者名を入力してください' });
    }

    // 登録した人（名前・ID）と、回答者本人のID（表示名と同じなら本人登録、違えば代理登録）
    const registeredBy = actor.user.display_name;
    const registeredByUserId = actor.user.id;
    const participantUserId = name === actor.user.display_name ? actor.user.id : null;

    let trimmedComment = null;
    if (comment !== undefined && comment !== null) {
      if (typeof comment !== 'string') {
        return sendJson(res, 400, { error: 'コメントの形式が正しくありません' });
      }
      trimmedComment = comment.trim() || null;
      if (trimmedComment && [...trimmedComment].length > COMMENT_MAX_LENGTH) {
        return sendJson(res, 400, { error: `コメントは${COMMENT_MAX_LENGTH}文字以内で入力してください` });
      }
    }

    if (!Array.isArray(answers) || answers.length === 0) {
      return sendJson(res, 400, { error: '候補ごとの回答（〇△✕）を選択してください' });
    }

    // 回答対象の候補が、この日程調整に属するものであることを確認する
    const { data: validCandidates, error: candidatesError } = await supabase
      .from('coordination_candidates')
      .select('id')
      .eq('coordination_id', coordination_id);
    if (candidatesError) {
      const { status, message } = responseErrorResponse(candidatesError);
      return sendJson(res, status, { error: message });
    }
    const validCandidateIds = new Set((validCandidates || []).map((c) => c.id));

    const normalizedAnswers = [];
    for (const answer of answers) {
      // 回答画面を開いている間に、日程調整の編集で候補が削除・日時変更された場合もここに来る
      if (!answer || !validCandidateIds.has(answer.candidate_id)) {
        return sendJson(res, 409, {
          error: 'この日程調整の内容が変更されました。画面を読み直してから回答してください。',
        });
      }
      if (!MARKS.includes(answer.mark)) {
        return sendJson(res, 400, { error: '回答は〇（yes）・△（maybe）・✕（no）のいずれかにしてください' });
      }
      normalizedAnswers.push({ candidate_id: answer.candidate_id, mark: answer.mark });
    }

    // 最大2回: （本人の回答なら自分のIDの行を更新）→ 新規作成 → 既存(23505)なら、既存の行の本人か確認して条件付き更新。
    // 更新対象0行のとき、直前に行が削除・変更されていた場合に備えてやり直す
    let response;
    for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
      if (participantUserId) {
        const own = await updateOwnResponse(supabase, {
          coordinationId: coordination_id,
          userId: participantUserId,
          name,
          comment: trimmedComment,
        });
        if (own.error) {
          const { status, message } = responseErrorResponse(own.error);
          return sendJson(res, status, { error: message });
        }
        if (own.row) {
          response = own.row;
          break;
        }
      }

      const insertResult = await supabase
        .from('coordination_responses')
        .insert({
          coordination_id,
          participant_name: name,
          participant_user_id: participantUserId,
          registered_by: registeredBy,
          registered_by_user_id: registeredByUserId,
          comment: trimmedComment,
        })
        .select()
        .single();
      if (!insertResult.error) {
        response = insertResult.data;
        break;
      }
      if (insertResult.error.code !== '23505') {
        const { status, message } = responseErrorResponse(insertResult.error);
        return sendJson(res, status, { error: message });
      }

      const { data: existing, error: existingError } = await supabase
        .from('coordination_responses')
        .select('*')
        .eq('coordination_id', coordination_id)
        .eq('participant_name', name)
        .maybeSingle();
      if (existingError) {
        const { status, message } = responseErrorResponse(existingError);
        return sendJson(res, status, { error: message });
      }
      if (!existing) continue; // 直前に削除された → 新規作成をやり直す

      if (!canActOnRow(actor, responseRowOwner(existing, coordination.branch), regionOf)) {
        const legacyRow = !existing.participant_user_id && !existing.registered_by_user_id;
        return sendJson(res, 409, { error: legacyRow ? LEGACY_SAME_NAME_MESSAGE : SAME_NAME_MESSAGE });
      }

      // 判定に使った本人のIDが、判定のあとに変わっていないことを条件に更新する
      let query = supabase.from('coordination_responses').update({ comment: trimmedComment }).eq('id', existing.id);
      query = existing.participant_user_id
        ? query.eq('participant_user_id', existing.participant_user_id)
        : query.is('participant_user_id', null);
      query = existing.registered_by_user_id
        ? query.eq('registered_by_user_id', existing.registered_by_user_id)
        : query.is('registered_by_user_id', null);
      const updateResult = await query.select();
      if (updateResult.error) {
        const { status, message } = responseErrorResponse(updateResult.error);
        return sendJson(res, status, { error: message });
      }
      if (updateResult.data.length > 0) {
        response = updateResult.data[0];
      }
    }
    if (!response) {
      return sendJson(res, 409, { error: SAME_NAME_MESSAGE });
    }

    // 回答（〇△✕）は upsert で保存する。先に全削除してから作り直す方式だと、
    // 削除後のinsertが失敗した時に以前の回答が消えたまま残ってしまうため、
    // 「今回の内容で上書き→送られなかった古い候補だけ削除」の順にし、
    // 前半（upsert）が失敗しても既存の回答は無傷のまま残るようにしている
    const submittedCandidateIds = normalizedAnswers.map((a) => a.candidate_id);

    const { data: answerRows, error: upsertAnswersError } = await supabase
      .from('coordination_answers')
      .upsert(
        normalizedAnswers.map((a) => ({ response_id: response.id, candidate_id: a.candidate_id, mark: a.mark })),
        { onConflict: 'response_id,candidate_id' }
      )
      .select();
    if (upsertAnswersError) {
      // response行・既存の回答はどちらも無傷のまま。再送すれば同じ内容で保存し直せる
      const { status, message } = responseErrorResponse(upsertAnswersError);
      return sendJson(res, status, { error: message });
    }

    // 今回送られなかった候補（過去の回答の残り）だけを削除する。
    // 今回の回答自体は上のupsertで既に保存済みなので、この削除が失敗しても
    // 古い候補が1件残るだけの軽微な影響にとどまる（ログに残しつつ処理は成功扱いにする）
    const { error: pruneAnswersError } = await supabase
      .from('coordination_answers')
      .delete()
      .eq('response_id', response.id)
      .not('candidate_id', 'in', `(${submittedCandidateIds.join(',')})`);
    if (pruneAnswersError) {
      console.error('coordination_answers prune failed:', pruneAnswersError);
    }

    return sendJson(res, 201, { ...response, coordination_answers: answerRows });
  }

  if (req.method === 'DELETE') {
    const { data: existing, error: fetchError } = await supabase
      .from('coordination_responses')
      .select('*')
      .eq('coordination_id', coordination_id)
      .eq('participant_name', participant_name)
      .maybeSingle();
    if (fetchError) {
      const { status, message } = responseErrorResponse(fetchError);
      return sendJson(res, status, { error: message });
    }
    if (!existing) {
      return sendJson(res, 404, { error: '回答が見つかりません' });
    }
    if (!canActOnRow(actor, responseRowOwner(existing, coordination.branch), regionOf)) {
      return sendJson(res, 403, { error: 'この回答を取り消せるのは、本人・登録した人か、この支部を管理する管理者だけです' });
    }

    const { error } = await supabase.from('coordination_responses').delete().eq('id', existing.id);
    if (error) {
      const { status, message } = responseErrorResponse(error);
      return sendJson(res, status, { error: message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['POST', 'DELETE']);
};
