const { getSupabaseClient } = require('./_lib/supabase');
const { resolveActor } = require('./_lib/auth');
const { writerName, writerId } = require('./_lib/permissions');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { SHARED_OWNER_BRANCHES, OWNER_BRANCHES } = require('./_lib/branches');
const { parseItemName, parseItemKind, addEquipmentOptions } = require('./_lib/branchOptions');

// quantityは数値として扱い、未指定・不正値は1に、負の数は0に丸める
function normalizeQuantity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 1;
  }
  return Math.max(0, Math.round(num));
}

// POST /api/equipment : 備品の新規登録
//   Googleでログインした有効な利用者は全員可（支部管理者・一般を含む）。
//   所有支部は誰でも19択（西県連・東県連・1〜16支部・その他）か未定（空欄）から選べる。
//   登録した人（created_by・created_by_user_id）はここでだけ入れる（編集では変えない）。
//   登録した人・更新者は、ログインしている人の表示名と自分のID（送られた updated_by は使わない）
//   品名（必須）・種類（item_kind・任意）は表記をそろえて保存し、全支部共通の候補として自動で覚える（migration 0021）
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { item_name, item_kind, management_number, location, image_url, memo, owner_branch, owner_person, is_shared, quantity, is_countable } = req.body || {};
  // resolveActor を通るのは、Googleでログインした有効な利用者だけ（全員が登録できる）
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  if (owner_branch && !OWNER_BRANCHES.includes(owner_branch)) {
    return sendJson(res, 400, { error: '所有の指定が正しくありません' });
  }
  const updated_by = writerName(actor);
  if (!item_name || !location || !updated_by) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }
  const name = parseItemName(item_name);
  if (name.error) {
    return sendJson(res, 400, { error: name.error });
  }
  const kind = parseItemKind(item_kind);
  if (kind.error) {
    return sendJson(res, 400, { error: kind.error });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('equipment')
    .insert({
      item_name: name.value,
      item_kind: kind.value,
      management_number: management_number || null,
      location,
      image_url: image_url || null,
      memo: memo || null,
      owner_branch: owner_branch || null,
      owner_person: owner_person || null,
      is_shared: SHARED_OWNER_BRANCHES.includes(owner_branch) ? true : Boolean(is_shared),
      quantity: normalizeQuantity(quantity),
      is_countable: Boolean(is_countable),
      updated_by,
      updated_by_user_id: writerId(actor),
      created_by: updated_by,
      created_by_user_id: writerId(actor),
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
    moved_by_user_id: data.updated_by_user_id,
    moved_at: data.updated_at,
  });
  if (historyError) {
    console.error('equipment_history insert failed:', historyError.message);
  }

  // 品名・種類を候補として覚える（失敗しても登録自体は成功扱い）
  await addEquipmentOptions(supabase, {
    itemName: data.item_name,
    kind: data.item_kind ? { itemName: data.item_name, value: data.item_kind } : null,
  });

  return sendJson(res, 201, data);
};
