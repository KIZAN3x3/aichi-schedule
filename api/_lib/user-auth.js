const { getSupabaseClient } = require('./supabase');

// Googleログイン（Supabase Auth）の利用者の判定と、ユーザー管理の権限判定。
// 権限の方針は CLAUDE.md の「Googleログイン＋RLS への移行」の節を参照。

function getBearerToken(req) {
  const header = (req.headers && req.headers.authorization) || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// Authorization: Bearer <access token> を Supabase Auth で検証し、app_users の行を取得する。
// 返り値: null = トークンが無い・無効 / { authUser, appUser } = 有効（未登録なら appUser は null）。
// app_users の取得に失敗した場合は例外を投げる（呼び出し側で500にする）
async function getAuthUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return null;

  const { data: appUser, error: appUserError } = await supabase
    .from('app_users')
    .select('*')
    .eq('id', data.user.id)
    .maybeSingle();
  if (appUserError) throw appUserError;

  return { authUser: data.user, appUser: appUser || null };
}

// 管理者の種類。status が active でなければ、どの権限も持たない
//   'grand' = システム管理者 / 'region' = 県連管理者 / 'branch' = 支部管理者 / null = 一般
function adminKind(user) {
  if (!user || user.status !== 'active') return null;
  if (user.is_admin) return 'grand';
  if (user.admin_scope === 'region') return 'region';
  if (user.admin_scope === 'branch') return 'branch';
  return null;
}

// 支部 → 県連（'西' / '東'）の対応表を読む
async function loadRegionOf() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('branch_regions').select('branch, region');
  if (error) throw error;
  const map = new Map(data.map((row) => [row.branch, row.region]));
  return (branch) => map.get(branch) || null;
}

// actor が target を見られる・操作できるか（承認・無効化・再有効化の範囲）
//   ・自分自身は誰も操作できない
//   ・システム管理者: 全員（ほかのシステム管理者を含む）
//   ・県連管理者: 相手の支部の県連が自分と同じ人。システム管理者は除く
//   ・支部管理者: 自分と同じ支部の一般ユーザーだけ（管理者は除く）
function canManageTarget(actor, target, regionOf) {
  if (!actor || !target || actor.id === target.id) return false;
  const kind = adminKind(actor);
  if (kind === 'grand') return true;
  if (kind === 'region') {
    const actorRegion = regionOf(actor.branch);
    return Boolean(actorRegion) && !target.is_admin && regionOf(target.branch) === actorRegion;
  }
  if (kind === 'branch') {
    return !target.is_admin && target.admin_scope === null && target.branch === actor.branch;
  }
  return false;
}

// 管理者の種類（admin_scope）を変えられるか。システム管理者と県連管理者だけ、かつ操作できる相手のみ。
// is_admin はAPIでは一切変更しない（SQL Editorでのみ変更する）
function canSetScope(actor, target, regionOf) {
  const kind = adminKind(actor);
  return (kind === 'grand' || kind === 'region') && canManageTarget(actor, target, regionOf);
}

// 相手の支部を変えられるか（destination を省くと「移動先によらず、変えられる相手か」を返す。一覧のボタン表示用）
//   ・システム管理者: 操作できる相手なら、どの支部へも（ほかのシステム管理者を含む。自分自身は不可）
//   ・県連管理者: 相手が自分の県連内の人で、移動先も自分の県連内の支部のときだけ（東西をまたぐ移動はシステム管理者だけ）
//   ・支部管理者・一般: 不可
function canSetBranch(actor, target, regionOf, destination) {
  const kind = adminKind(actor);
  if (!canManageTarget(actor, target, regionOf)) return false;
  if (kind === 'grand') return true;
  if (kind === 'region') {
    return destination === undefined || regionOf(destination) === regionOf(actor.branch);
  }
  return false;
}

module.exports = { getBearerToken, getAuthUser, adminKind, loadRegionOf, canManageTarget, canSetScope, canSetBranch };
