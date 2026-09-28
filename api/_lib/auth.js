const { getAuthUser } = require('./user-auth');

// banner-maker-v2と同じパスワード体系: 123=一般ユーザー, 123123=マスター管理者
const PASSWORD_ROLES = {
  '123': 'user',
  '123123': 'admin',
};

function resolveRole(password) {
  return PASSWORD_ROLES[password] || null;
}

// 共通パスワード、または Googleログインの利用者（Authorization: Bearer のトークン）で権限を判定する。
//   ・共通パスワードが正しければ、今までどおりその権限
//   ・トークンが有効で app_users.status が active なら、グランドマスター(is_admin)は 'admin'、それ以外は 'user'
//     （県連管理者・支部管理者も、既存APIでは一般ユーザーとして扱う。正しい権限範囲は段階3-2で入れる）
//   ・どちらでもなければ null
// 本人判定（poster_name 等の名前の比較）はここでは行わない（呼び出し側で今までどおり行う）
async function resolveRequestRole(req, password) {
  const role = resolveRole(password);
  if (role) return role;

  let auth;
  try {
    auth = await getAuthUser(req);
  } catch (err) {
    console.error('resolveRequestRole: app_users の取得に失敗:', err);
    return null;
  }
  if (!auth || !auth.appUser || auth.appUser.status !== 'active') return null;
  return auth.appUser.is_admin ? 'admin' : 'user';
}

module.exports = { resolveRole, resolveRequestRole };
