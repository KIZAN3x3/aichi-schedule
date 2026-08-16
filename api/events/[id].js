const { getSupabaseClient } = require('../_lib/supabase');
const { resolveRole } = require('../_lib/auth');
const { sendJson, methodNotAllowed } = require('../_lib/http');

// PUT /api/events/:id    予定編集（本人 or 管理者のみ）
// DELETE /api/events/:id 予定削除（本人 or 管理者のみ）
module.exports = async (req, res) => {
  const { id } = req.query;
  const supabase = getSupabaseClient();

  if (req.method === 'PUT') {
    const { date, time, end_time, finished, place, content, poster_name, category, password } = req.body || {};
    const role = resolveRole(password);
    if (!role) {
      return sendJson(res, 401, { error: 'パスワードが違います' });
    }
    if (!poster_name) {
      return sendJson(res, 400, { error: 'poster_nameが必要です' });
    }
    if (typeof category === 'string' && category.trim().length > 50) {
      return sendJson(res, 400, { error: 'カテゴリは50文字以内で入力してください' });
    }
    if (typeof end_time === 'string' && end_time.trim() && time !== undefined && end_time.trim() <= time) {
      return sendJson(res, 400, { error: '終了時間は開始時間より後にしてください' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('events')
      .select('poster_name, time')
      .eq('id', id)
      .single();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '予定が見つかりません' });
    }
    if (role !== 'admin' && existing.poster_name !== poster_name) {
      return sendJson(res, 403, { error: '自分の投稿のみ編集できます' });
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
    const { poster_name, password } = req.body || {};
    const role = resolveRole(password);
    if (!role) {
      return sendJson(res, 401, { error: 'パスワードが違います' });
    }
    if (!poster_name) {
      return sendJson(res, 400, { error: 'poster_nameが必要です' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('events')
      .select('poster_name')
      .eq('id', id)
      .single();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '予定が見つかりません' });
    }
    if (role !== 'admin' && existing.poster_name !== poster_name) {
      return sendJson(res, 403, { error: '自分の投稿のみ削除できます' });
    }

    const { error } = await supabase.from('events').delete().eq('id', id);
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
};
