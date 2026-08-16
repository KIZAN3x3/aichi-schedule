const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');

// POST /api/equipment : 備品の新規登録（マスター管理者のみ）
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { item_name, management_number, location, image_url, memo, updated_by, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  if (role !== 'admin') {
    return sendJson(res, 403, { error: '新規登録はマスター管理者のみ可能です' });
  }
  if (!item_name || !location || !updated_by) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('equipment')
    .insert({
      item_name,
      management_number: management_number || null,
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

  // 初回登録も移動履歴の1件目として記録する
  const { error: historyError } = await supabase.from('equipment_history').insert({
    equipment_id: data.id,
    location: data.location,
    moved_by: data.updated_by,
    moved_at: data.updated_at,
  });
  if (historyError) {
    console.error('equipment_history insert failed:', historyError.message);
  }

  return sendJson(res, 201, data);
};
