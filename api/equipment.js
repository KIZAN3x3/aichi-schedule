const { getSupabaseClient } = require('./_lib/supabase');
const { resolveActor } = require('./_lib/auth');
const { regionResolverFor, canManageBranch, writerName, writerId, forbiddenMessage } = require('./_lib/permissions');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { SHARED_OWNER_BRANCHES } = require('./_lib/branches');

// quantityは数値として扱い、未指定・不正値は1に、負の数は0に丸める
function normalizeQuantity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 1;
  }
  return Math.max(0, Math.round(num));
}

// POST /api/equipment : 備品の新規登録（所有支部を管理できる管理者のみ）
//   システム管理者・共通パスワードの管理者はどの所有支部でも可。県連管理者は所有支部が自分の県連内のときだけ
//   （所有支部が空欄・「その他」の備品は、県連に属さないため県連管理者は登録できない）
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
  const regionOf = await regionResolverFor(actor);
  if (!canManageBranch(actor, owner_branch || null, regionOf)) {
    return sendJson(res, 403, {
      error: forbiddenMessage(
        actor,
        '新規登録はマスター管理者のみ可能です',
        '備品を登録できるのは、所有する支部を管理する管理者だけです（県連管理者は、所有を自分の県連内の支部にしてください）'
      ),
    });
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
