const { getAuthUser, getBearerToken, adminKind } = require('./user-auth');

// banner-maker-v2と同じパスワード体系: 123=一般ユーザー, 123123=マスター管理者
const PASSWORD_ROLES = {
  '123': 'user',
  '123123': 'admin',
};

function resolveRole(password) {
  return PASSWORD_ROLES[password] || null;
}

// リクエストした人（actor）を判定する。共通パスワードとGoogleログインの並行運用に対応する。
// 返り値:
//   { ok: true, actor }
//     actor.via  : 'password'（共通パスワード） / 'google'（Googleログイン）
//     actor.role : 'admin' = 全支部のデータを管理できる（共通パスワードの管理者・システム管理者） / 'user' = それ以外
//     actor.user : Googleのとき app_users の行（共通パスワードのときは null）
//     actor.kind : Googleのとき管理者の種類（'grand' = システム管理者 / 'region' = 県連管理者 / 'branch' = 支部管理者 / null）
//   { ok: false, status, error }
//     ・共通パスワードが違い、Authorization も無い → 401「パスワードが違います」（今までどおり）
//     ・Authorization が付いていて、トークンが無効・期限切れ → 401「ログインし直してください」
//     ・トークンは有効だが、未登録・承認待ち・無効 → 403「このアカウントは現在利用できません」
// 本人判定・支部の範囲の判定は api/_lib/permissions.js で行う
async function resolveActor(req, password) {
  const role = resolveRole(password);
  if (role) {
    return { ok: true, actor: { via: 'password', role, user: null, kind: null } };
  }
  if (!getBearerToken(req)) {
    return { ok: false, status: 401, error: 'パスワードが違います' };
  }

  let auth;
  try {
    auth = await getAuthUser(req);
  } catch (err) {
    console.error('resolveActor: app_users の取得に失敗:', err);
    return { ok: false, status: 500, error: 'ユーザー情報の取得に失敗しました。時間をおいて再度お試しください' };
  }
  if (!auth) {
    return { ok: false, status: 401, error: 'ログインし直してください' };
  }
  const user = auth.appUser;
  if (!user || user.status !== 'active') {
    return {
      ok: false,
      status: 403,
      error: 'このアカウントは現在利用できません（利用登録が済んでいないか、承認待ち、または無効です）',
    };
  }
  return {
    ok: true,
    actor: { via: 'google', role: user.is_admin ? 'admin' : 'user', user, kind: adminKind(user) },
  };
}

module.exports = { resolveRole, resolveActor };
