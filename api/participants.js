const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');

// POST /api/participants   : 予定への参加登録
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
    const { data, error } = await supabase
      .from('participants')
      .insert({ event_id, participant_name })
      .select()
      .single();

    if (error) {
      return sendJson(res, 500, { error: error.message });
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
