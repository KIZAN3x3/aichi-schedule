const { getSupabaseClient } = require('../_lib/supabase');
const { resolveActor } = require('../_lib/auth');
const { regionResolverFor, canActOnRow, writerName, writerId } = require('../_lib/permissions');
const { sendJson, methodNotAllowed } = require('../_lib/http');
const { SHARED_OWNER_BRANCHES } = require('../_lib/branches');
const { parseItemName, parseItemKind, addEquipmentOptions } = require('../_lib/branchOptions');
const { isOwnImageUrl } = require('../_lib/equipmentImages');

// quantityは数値として扱い、未指定・不正値は1に、負の数は0に丸める
function normalizeQuantity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 1;
  }
  return Math.max(0, Math.round(num));
}

// PUT /api/equipment/:id    品目名・場所・画像・メモ更新（一般・管理者とも同一権限）
//                           更新者名はログインしている人の表示名、ユーザーIDも記録する（送られた updated_by は使わない）
//                           登録した人（created_by・created_by_user_id）は変えない
//                           品名・種類（item_kind）は、今の値から変わったときだけ表記をそろえて保存し、候補として覚える。
//                           変わっていなければ保存済みの値をそのまま残す（候補に無い既存の品名も書き換えず、候補にも入れない）
// DELETE /api/equipment/:id 備品削除。登録した本人（created_by_user_id が自分）か、所有支部を管理できる管理者
//                           （システム管理者は全部。県連管理者は所有支部が自分の県連内のときだけ）。
//                           登録した人が空欄の備品（移行前）は管理者だけ
module.exports = async (req, res) => {
  const { id } = req.query;
  const supabase = getSupabaseClient();

  if (req.method === 'PUT') {
    const { item_name, item_kind, management_number, location, image_url, memo, owner_branch, owner_person, is_shared, quantity, is_countable } = req.body || {};
    const auth = await resolveActor(req);
    if (!auth.ok) {
      return sendJson(res, auth.status, { error: auth.error });
    }
    const { actor } = auth;
    const updated_by = writerName(actor);

    const { data: existing, error: fetchError } = await supabase
      .from('equipment')
      .select('location, owner_branch, item_name, item_kind')
      .eq('id', id)
      .single();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '備品が見つかりません' });
    }

    const updates = { updated_by, updated_by_user_id: writerId(actor), updated_at: new Date().toISOString() };
    // 品名: 送られた値が今の値と同じなら何もしない。変わったときだけ、そろえた値で保存して候補に覚える
    let learnName = false;
    if (item_name !== undefined && item_name !== existing.item_name) {
      const name = parseItemName(item_name);
      if (name.error) {
        return sendJson(res, 400, { error: name.error });
      }
      if (name.value !== existing.item_name) {
        updates.item_name = name.value;
        learnName = true;
      }
    }
    // 種類: 品名と同じ考え方。空にしたら null（候補には何も覚えない）
    let learnKind = false;
    if (item_kind !== undefined && (item_kind ?? '') !== (existing.item_kind ?? '')) {
      const kind = parseItemKind(item_kind);
      if (kind.error) {
        return sendJson(res, 400, { error: kind.error });
      }
      if (kind.value !== (existing.item_kind ?? null)) {
        updates.item_kind = kind.value;
        learnKind = kind.value !== null;
      }
    }
    if (management_number !== undefined) updates.management_number = management_number;
    if (location !== undefined) updates.location = location;
    if (image_url !== undefined) {
      // 画像は、このバケットの公開URLの形だけを受け付ける（段階5 ③。空なら画像なし）
      if (image_url && !isOwnImageUrl(image_url)) {
        return sendJson(res, 400, { error: '画像のURLが正しくありません。画像を選び直してください' });
      }
      updates.image_url = image_url || null;
    }
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

    // 変えた品名・種類だけを候補として覚える（失敗しても更新自体は成功扱い）
    if (learnName || learnKind) {
      await addEquipmentOptions(supabase, {
        itemName: learnName ? data.item_name : null,
        kind: learnKind ? { itemName: data.item_name, value: data.item_kind } : null,
      });
    }

    return sendJson(res, 200, data);
  }

  if (req.method === 'DELETE') {
    const auth = await resolveActor(req);
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
    if (!canActOnRow(actor, { branch: existing.owner_branch, userIds: [existing.created_by_user_id] }, regionOf)) {
      return sendJson(res, 403, { error: 'この備品を削除できるのは、登録した本人か、所有する支部を管理する管理者だけです' });
    }

    const { error } = await supabase.from('equipment').delete().eq('id', id);
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
};
