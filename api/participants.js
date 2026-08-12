const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');

// POST /api/participants : 予定への参加登録
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { event_id, participant_name, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  if (!event_id || !participant_name) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('participants')
    .insert({ event_id, participant_name })
    .select()
    .single();

  if (error) {
    return sendJson(res, 500, { error: error.message });
  }
  return sendJson(res, 201, data);
};
