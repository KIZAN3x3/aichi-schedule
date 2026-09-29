const { getAuthUser, getBearerToken, adminKind } = require('./user-auth');

// リクエストした人（actor）を判定する。Googleログイン（Supabase Auth のトークン）だけを受け付ける
// （共通パスワードのログインは段階5で廃止した。body に password が送られてきても見ない）。
// 返り値:
//   { ok: true, actor }
//     actor.via  : 'google'
//     actor.role : 'admin' = システム管理者（is_admin。全支部のデータを管理できる） / 'user' = それ以外
//     actor.user : app_users の行
//     actor.kind : 管理者の種類（'grand' = システム管理者 / 'region' = 県連管理者 / 'branch' = 支部管理者 / null）
//   { ok: false, status, error }
//     ・Authorization が無い → 401「ログインしてください」
//     ・トークンが無効・期限切れ → 401「ログインし直してください」
//     ・トークンは有効だが、未登録・承認待ち・無効 → 403「このアカウントは現在利用できません」
// 本人判定・支部の範囲の判定は api/_lib/permissions.js で行う
async function resolveActor(req) {
  if (!getBearerToken(req)) {
    return { ok: false, status: 401, error: 'ログインしてください' };
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

module.exports = { resolveActor };
