const { getSupabaseClient } = require('../_lib/supabase');
const { resolveRole } = require('../_lib/auth');
const { sendJson, methodNotAllowed } = require('../_lib/http');

// PUT /api/equipment/:id    場所・メモ更新（一般・管理者とも同一権限）。画像は新規登録時のみ設定可、編集では変更不可
// DELETE /api/equipment/:id 備品削除（マスター管理者のみ）
module.exports = async (req, res) => {
  const { id } = req.query;
  const supabase = getSupabaseClient();

  if (req.method === 'PUT') {
    const { item_name, management_number, location, memo, updated_by, password } = req.body || {};
    const role = resolveRole(password);
    if (!role) {
      return sendJson(res, 401, { error: 'パスワードが違います' });
    }
    if (!updated_by) {
      return sendJson(res, 400, { error: 'updated_byが必要です' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('equipment')
      .select('location')
      .eq('id', id)
      .single();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '備品が見つかりません' });
    }

    const updates = { updated_by, updated_at: new Date().toISOString() };
    if (item_name !== undefined) updates.item_name = item_name;
    if (management_number !== undefined) updates.management_number = management_number;
    if (location !== undefined) updates.location = location;
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

    // 保管場所が実際に変わった時だけ移動履歴を追加する
    if (location !== undefined && location !== existing.location) {
      const { error: historyError } = await supabase.from('equipment_history').insert({
        equipment_id: data.id,
        location: data.location,
        moved_by: data.updated_by,
        moved_at: data.updated_at,
      });
      if (historyError) {
        console.error('equipment_history insert failed:', historyError.message);
      }
    }

    return sendJson(res, 200, data);
  }

  if (req.method === 'DELETE') {
    const { password } = req.body || {};
    const role = resolveRole(password);
    if (!role) {
      return sendJson(res, 401, { error: 'パスワードが違います' });
    }
    if (role !== 'admin') {
      return sendJson(res, 403, { error: '削除はマスター管理者のみ可能です' });
    }

    const { error } = await supabase.from('equipment').delete().eq('id', id);
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
};
