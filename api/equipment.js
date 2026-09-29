const { getSupabaseClient } = require('./_lib/supabase');
const { resolveActor } = require('./_lib/auth');
const { isGlobalManager, writerName, writerId } = require('./_lib/permissions');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { SHARED_OWNER_BRANCHES, OWNER_BRANCHES } = require('./_lib/branches');

// quantityは数値として扱い、未指定・不正値は1に、負の数は0に丸める
function normalizeQuantity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 1;
  }
  return Math.max(0, Math.round(num));
}

// POST /api/equipment : 備品の新規登録
//   Googleでログインした有効な利用者は全員可（支部管理者・一般を含む）。共通パスワードは管理者だけ（一般は不可）。
//   所有支部は誰でも19択（西県連・東県連・1〜16支部・その他）か未定（空欄）から選べる。
//   登録した人（created_by・created_by_user_id）はここでだけ入れる（編集では変えない）。
//   Googleの人は表示名と自分のID、共通パスワードの管理者は送られた名前（IDは空欄）
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { item_name, management_number, location, image_url, memo, owner_branch, owner_person, is_shared, quantity, is_countable, password } = req.body || {};
  const auth = await resolveActor(req, password);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  // resolveActor を通った Googleの人は status = 'active' の利用者だけ
  if (actor.via !== 'google' && !isGlobalManager(actor)) {
    return sendJson(res, 403, { error: '新規登録はマスター管理者のみ可能です' });
  }
  if (owner_branch && !OWNER_BRANCHES.includes(owner_branch)) {
    return sendJson(res, 400, { error: '所有の指定が正しくありません' });
  }
  // 更新者名: Googleの人は表示名（送られた値は使わない）
  const updated_by = writerName(actor, (req.body || {}).updated_by);
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

  return sendJson(res, 201, data);
};
