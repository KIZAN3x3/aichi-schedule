const { getSupabaseClient } = require('../_lib/supabase');
const { resolveActor } = require('../_lib/auth');
const { sendJson, methodNotAllowed } = require('../_lib/http');
const { regionResolverFor, canActOnRow, forbiddenMessage } = require('../_lib/permissions');

// PUT /api/events/:id    予定編集（本人 or その支部を管理できる管理者のみ）
//                        終了・戻す（finished だけの更新）は、その予定に「参加」で登録している本人もできる
// DELETE /api/events/:id 予定削除（本人 or その支部を管理できる管理者のみ）
//   body: { ..., requested_by, password }
//   requested_by: 共通パスワードの人の名前（ユーザーIDが空欄の予定を、名前の一致で操作するときに使う）。Googleの人は不要
//   本人判定は api/_lib/permissions.js の canActOnRow（予定の本人 = poster_user_id / poster_name）
module.exports = async (req, res) => {
  const { id } = req.query;
  const supabase = getSupabaseClient();

  if (req.method === 'PUT') {
    const { date, time, end_time, finished, place, content, category, requested_by, password } = req.body || {};
    const auth = await resolveActor(req, password);
    if (!auth.ok) {
      return sendJson(res, auth.status, { error: auth.error });
    }
    const { actor } = auth;
    if (typeof category === 'string' && category.trim().length > 50) {
      return sendJson(res, 400, { error: 'カテゴリは50文字以内で入力してください' });
    }
    if (typeof end_time === 'string' && end_time.trim() && time !== undefined && end_time.trim() <= time) {
      return sendJson(res, 400, { error: '終了時間は開始時間より後にしてください' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('events')
      .select('branch, poster_name, poster_user_id, time')
      .eq('id', id)
      .single();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '予定が見つかりません' });
    }

    const regionOf = await regionResolverFor(actor);
    const isOwnerOrManager = canActOnRow(
      actor,
      { branch: existing.branch, userIds: [existing.poster_user_id], names: [existing.poster_name] },
      regionOf,
      requested_by
    );
    // finished だけの更新（終了・戻す）なら、この予定に「参加」で登録している本人も許可する
    const onlyFinished =
      finished !== undefined &&
      [date, time, end_time, place, content, category].every((value) => value === undefined);
    let allowed = isOwnerOrManager;
    if (!allowed && onlyFinished) {
      allowed = await isGoingParticipant(supabase, actor, id, requested_by);
    }
    if (!allowed) {
      return sendJson(res, 403, {
        error: forbiddenMessage(
          actor,
          '自分の投稿のみ編集できます',
          'この予定を変更できるのは、登録した本人か、この支部を管理する管理者だけです'
        ),
      });
    }
    if (typeof end_time === 'string' && end_time.trim() && time === undefined && end_time.trim() <= existing.time) {
      return sendJson(res, 400, { error: '終了時間は開始時間より後にしてください' });
    }

    const updates = {};
    if (date !== undefined) updates.date = date;
    if (time !== undefined) updates.time = time;
    if (end_time !== undefined) updates.end_time = end_time.trim() || null;
    if (place !== undefined) updates.place = place;
    if (content !== undefined) updates.content = content;
    if (category !== undefined) updates.category = category.trim() || null;
    if (finished === true) updates.finished_at = new Date().toISOString();
    if (finished === false) updates.finished_at = null;

    const { data, error } = await supabase
      .from('events')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 200, data);
  }

  if (req.method === 'DELETE') {
    const { requested_by, password } = req.body || {};
    const auth = await resolveActor(req, password);
    if (!auth.ok) {
      return sendJson(res, auth.status, { error: auth.error });
    }
    const { actor } = auth;

    const { data: existing, error: fetchError } = await supabase
      .from('events')
      .select('branch, poster_name, poster_user_id')
      .eq('id', id)
      .single();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '予定が見つかりません' });
    }
    const regionOf = await regionResolverFor(actor);
    if (
      !canActOnRow(
        actor,
        { branch: existing.branch, userIds: [existing.poster_user_id], names: [existing.poster_name] },
        regionOf,
        requested_by
      )
    ) {
      return sendJson(res, 403, {
        error: forbiddenMessage(
          actor,
          '自分の投稿のみ削除できます',
          'この予定を削除できるのは、登録した本人か、この支部を管理する管理者だけです'
        ),
      });
    }

    const { error } = await supabase.from('events').delete().eq('id', id);
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
};

// この予定に「参加」で登録している本人か（終了・戻すの許可に使う）。
// 参加の行の本人 = participant_user_id（IDが空欄の行は、participant_name と共通パスワードの人の名前の一致）。
// 管理者かどうかは呼び出し側で判定済みのため、ここでは本人かどうかだけを見る
async function isGoingParticipant(supabase, actor, eventId, requestedBy) {
  const { data, error } = await supabase
    .from('participants')
    .select('participant_name, participant_user_id')
    .eq('event_id', eventId)
    .eq('status', 'going');
  if (error || !data) return false;
  const asMember = { ...actor, role: 'user', kind: null };
  return data.some((p) =>
    canActOnRow(asMember, { branch: null, userIds: [p.participant_user_id], names: [p.participant_name] }, null, requestedBy)
  );
}
