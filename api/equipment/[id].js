const { getSupabaseClient } = require('../_lib/supabase');
const { resolveActor } = require('../_lib/auth');
const { regionResolverFor, canActOnRow, writerName, writerId, forbiddenMessage } = require('../_lib/permissions');
const { sendJson, methodNotAllowed } = require('../_lib/http');
const { SHARED_OWNER_BRANCHES } = require('../_lib/branches');

// quantityは数値として扱い、未指定・不正値は1に、負の数は0に丸める
function normalizeQuantity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 1;
  }
  return Math.max(0, Math.round(num));
}

// PUT /api/equipment/:id    品目名・場所・画像・メモ更新（一般・管理者とも同一権限）
//                           Googleの人は、更新者名に表示名を使い、ユーザーIDも記録する（送られた updated_by は使わない）
//                           登録した人（created_by・created_by_user_id）は変えない
// DELETE /api/equipment/:id 備品削除。登録した本人（created_by_user_id が自分）か、所有支部を管理できる管理者
//                           （システム管理者・共通パスワードの管理者は全部。県連管理者は所有支部が自分の県連内のときだけ）。
//                           登録した人が空欄の備品（移行前・共通パスワードで登録）は管理者だけ（名前の一致では判定しない）
module.exports = async (req, res) => {
  const { id } = req.query;
  const supabase = getSupabaseClient();

  if (req.method === 'PUT') {
    const { item_name, management_number, location, image_url, memo, owner_branch, owner_person, is_shared, quantity, is_countable, password } = req.body || {};
    const auth = await resolveActor(req, password);
    if (!auth.ok) {
      return sendJson(res, auth.status, { error: auth.error });
    }
    const { actor } = auth;
    const updated_by = writerName(actor, (req.body || {}).updated_by);
    if (!updated_by) {
      return sendJson(res, 400, { error: 'updated_byが必要です' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('equipment')
      .select('location, owner_branch')
      .eq('id', id)
      .single();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '備品が見つかりません' });
    }

    const updates = { updated_by, updated_by_user_id: writerId(actor), updated_at: new Date().toISOString() };
    if (item_name !== undefined) updates.item_name = item_name;
    if (management_number !== undefined) updates.management_number = management_number;
    if (location !== undefined) updates.location = location;
    if (image_url !== undefined) updates.image_url = image_url;
    if (memo !== undefined) updates.memo = memo;
    if (owner_branch !== undefined) updates.owner_branch = owner_branch || null;
    if (owner_person !== undefined) updates.owner_person = owner_person || null;
    if (quantity !== undefined) updates.quantity = normalizeQuantity(quantity);
    if (is_countable !== undefined) updates.is_countable = Boolean(is_countable);

    // owner_branchが西県連/東県連(更新後の実効値)ならis_sharedは常にtrueを強制する
    const effectiveOwnerBranch = owner_branch !== undefined ? owner_branch : existing.owner_branch;
    if (SHARED_OWNER_BRANCHES.includes(effectiveOwnerBranch)) {
      updates.is_shared = true;
    } else if (is_shared !== undefined) {
      updates.is_shared = Boolean(is_shared);
    }

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
        moved_by_user_id: data.updated_by_user_id,
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
    const auth = await resolveActor(req, password);
    if (!auth.ok) {
      return sendJson(res, auth.status, { error: auth.error });
    }
    const { actor } = auth;

    const { data: existing, error: fetchError } = await supabase
      .from('equipment')
      .select('owner_branch, created_by_user_id')
      .eq('id', id)
      .maybeSingle();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '備品が見つかりません' });
    }
    const regionOf = await regionResolverFor(actor);
    const owner = { branch: existing.owner_branch, userIds: [existing.created_by_user_id], names: [] };
    if (!canActOnRow(actor, owner, regionOf)) {
      return sendJson(res, 403, {
        error: forbiddenMessage(
          actor,
          '削除はマスター管理者のみ可能です',
          'この備品を削除できるのは、登録した本人か、所有する支部を管理する管理者だけです'
        ),
      });
    }

    const { error } = await supabase.from('equipment').delete().eq('id', id);
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
};
