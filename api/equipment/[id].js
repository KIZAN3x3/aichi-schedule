const { getSupabaseClient } = require('../_lib/supabase');
const { resolveRole } = require('../_lib/auth');
const { sendJson, methodNotAllowed } = require('../_lib/http');

// PUT /api/equipment/:id    場所・画像・メモ更新（一般・管理者とも同一権限）
// DELETE /api/equipment/:id 備品削除（一般・管理者とも同一権限）
module.exports = async (req, res) => {
  const { id } = req.query;
  const supabase = getSupabaseClient();

  if (req.method === 'PUT') {
    const { item_name, location, image_url, memo, updated_by, password } = req.body || {};
    const role = resolveRole(password);
    if (!role) {
      return sendJson(res, 401, { error: 'パスワードが違います' });
    }
    if (!updated_by) {
      return sendJson(res, 400, { error: 'updated_byが必要です' });
    }

    const updates = { updated_by, updated_at: new Date().toISOString() };
    if (item_name !== undefined) updates.item_name = item_name;
    if (location !== undefined) updates.location = location;
    if (image_url !== undefined) updates.image_url = image_url;
    if (memo !== undefined) updates.memo = memo;

    const { data, error } = await supabase
      .from('equipment')
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
    const { password } = req.body || {};
    const role = resolveRole(password);
    if (!role) {
      return sendJson(res, 401, { error: 'パスワードが違います' });
    }

    const { error } = await supabase.from('equipment').delete().eq('id', id);
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
};
