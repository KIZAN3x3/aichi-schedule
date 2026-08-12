const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');

// POST /api/equipment : 備品の新規登録（一般・管理者とも同一権限）
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { item_name, location, image_url, memo, updated_by, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  if (!item_name || !location || !updated_by) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('equipment')
    .insert({
      item_name,
      location,
      image_url: image_url || null,
      memo: memo || null,
      updated_by,
    })
    .select()
    .single();

  if (error) {
    return sendJson(res, 500, { error: error.message });
  }
  return sendJson(res, 201, data);
};
