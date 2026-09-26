const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');

const MARKS = ['yes', 'maybe', 'no'];
const COMMENT_MAX_LENGTH = 200;
const REGISTERED_BY_MAX_LENGTH = 50;

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
//   body: { coordination_id, participant_name, registered_by?, comment?, answers: [{candidate_id, mark}], password }
//   同じ coordination_id + participant_name が既にあれば新規作成せず更新する。
//   更新できるのは 本人(registered_by === participant_name) または 最初の登録者(既存行のregistered_by) のみ。
//   それ以外は409。参加者機能(api/participants.js)と同じ考え方。
// DELETE /api/coordination-responses : 回答の取り消し（本人 または 代理登録した人のみ）
//   body: { coordination_id, participant_name, requested_by, password }
// 登録・編集・取消はどれも、調整中(status='open')のときだけ受け付ける（決定済みは409）。
// ※状態の確認と書き込みの間に決定された場合は、その回答が決定済みの調整に残りうる
//   （数十〜数百ミリ秒の間だけ。データは壊れない。DBトリガーでの厳密な防止は入れていない）
module.exports = async (req, res) => {
  const { coordination_id, participant_name, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  if (!coordination_id || !participant_name) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }

  const supabase = getSupabaseClient();

  if (req.method === 'POST' || req.method === 'DELETE') {
    const { data: coordination, error: coordinationError } = await supabase
      .from('coordinations')
      .select('status')
      .eq('id', coordination_id)
      .maybeSingle();
    if (coordinationError) {
      const { status, message } = responseErrorResponse(coordinationError);
      return sendJson(res, status, { error: message });
    }
    if (!coordination) {
      return sendJson(res, 404, { error: '指定された日程調整が見つかりません' });
    }
    if (coordination.status !== 'open') {
      return sendJson(res, 409, { error: 'この日程調整は決定済みのため、回答できません。' });
    }
  }

  if (req.method === 'POST') {
    const { registered_by, comment, answers } = req.body;

    if (typeof coordination_id !== 'string' || typeof participant_name !== 'string') {
      return sendJson(res, 400, { error: '入力内容が正しくありません' });
    }

    const name = participant_name.trim();
    if (!name) {
      return sendJson(res, 400, { error: '参加者名を入力してください' });
    }

    // registered_by: 未指定は本人登録として participant_name を採用（participants.jsと同じ互換）
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

    const restrictToTarget = (query) => {
      let q = query.eq('coordination_id', coordination_id).eq('participant_name', name);
      if (registeredBy !== name) {
        q = q.eq('registered_by', registeredBy);
      }
      return q;
    };

    // 最大2回: 新規作成 → 既存(23505)なら条件付き更新。更新対象0行のとき、
    // 直前に行が削除されていた場合に備えて新規作成をやり直す
    let response;
    for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
      const insertResult = await supabase
        .from('coordination_responses')
        .insert({
          coordination_id,
          participant_name: name,
          registered_by: registeredBy,
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

      const table = supabase.from('coordination_responses');
      const updateResult = await restrictToTarget(
        table.update({ comment: trimmedComment })
      ).select();
      if (updateResult.error) {
        const { status, message } = responseErrorResponse(updateResult.error);
        return sendJson(res, status, { error: message });
      }
      if (updateResult.data.length > 0) {
        response = updateResult.data[0];
      }
    }
    if (!response) {
      return sendJson(res, 409, { error: 'その名前は既に回答済みです' });
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
    const { requested_by } = req.body;
    const trimmedRequestedBy = typeof requested_by === 'string' ? requested_by.trim() : '';
    if (!trimmedRequestedBy) {
      return sendJson(res, 400, { error: '操作している人の名前を入力してください' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('coordination_responses')
      .select('participant_name, registered_by')
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
    if (existing.participant_name !== trimmedRequestedBy && existing.registered_by !== trimmedRequestedBy) {
      return sendJson(res, 403, { error: '本人または代理登録した人のみ取り消せます' });
    }

    const { error } = await supabase
      .from('coordination_responses')
      .delete()
      .eq('coordination_id', coordination_id)
      .eq('participant_name', participant_name);
    if (error) {
      const { status, message } = responseErrorResponse(error);
      return sendJson(res, status, { error: message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['POST', 'DELETE']);
};
