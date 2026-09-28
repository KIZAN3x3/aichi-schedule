const { getSupabaseClient } = require('./_lib/supabase');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES } = require('./_lib/branches');
const { getAuthUser, adminKind, loadRegionOf, canManageTarget, canSetScope } = require('./_lib/user-auth');

// Googleログインの利用者（app_users）に関するAPI。
// Vercel Hobbyプランのサーバーレス関数数上限（12個）のため、1ファイルにまとめてクエリ文字列(?action=)で分岐する。
//   GET  /api/users?action=me       : 自分の状態
//   POST /api/users?action=register : 初回登録（表示名・所属支部。status='pending'）
//   POST /api/users?action=login    : 最終ログイン日時の記録（Googleから戻った直後に1回だけ呼ぶ）
//   GET  /api/users?action=list     : ユーザー一覧（管理者のみ。自分の権限範囲のユーザーだけ）
//   POST /api/users?action=update   : 承認・無効化・再有効化・管理者の種類の変更（管理者のみ）
// どれも Authorization: Bearer <Supabaseのアクセストークン> が必要。共通パスワードでは使えない。

const DISPLAY_NAME_MAX_LENGTH = 50;
const ADMIN_SCOPES = [null, 'branch', 'region'];
const LIST_USERS_PER_PAGE = 1000;

// 一覧・更新で返す列（is_admin / admin_scope は画面での表示用）
const PUBLIC_COLUMNS = [
  'id', 'display_name', 'branch', 'status', 'is_admin', 'admin_scope',
  'created_at', 'approved_at', 'approved_by', 'last_login_at',
];

function pick(row) {
  return Object.fromEntries(PUBLIC_COLUMNS.map((key) => [key, row[key]]));
}

module.exports = async (req, res) => {
  const { action } = req.query || {};
  const routes = {
    me: ['GET', handleMe],
    register: ['POST', handleRegister],
    login: ['POST', handleLogin],
    list: ['GET', handleList],
    update: ['POST', handleUpdate],
  };
  const route = routes[action];
  if (!route) {
    return sendJson(res, 400, { error: 'actionが不正です' });
  }
  const [method, handler] = route;
  if (req.method !== method) {
    return methodNotAllowed(res, [method]);
  }

  let auth;
  try {
    auth = await getAuthUser(req);
  } catch (err) {
    console.error('users: app_users の取得に失敗:', err);
    return sendJson(res, 500, { error: 'ユーザー情報の取得に失敗しました。時間をおいて再度お試しください' });
  }
  if (!auth) {
    return sendJson(res, 401, { error: 'ログインし直してください' });
  }

  try {
    return await handler(req, res, auth);
  } catch (err) {
    console.error(`users(${action}) failed:`, err);
    return sendJson(res, 500, { error: '処理に失敗しました。時間をおいて再度お試しください' });
  }
};

// GET ?action=me
//   出力: { status: 'unregistered'|'pending'|'active'|'disabled', email, google_name, user }
function handleMe(req, res, { authUser, appUser }) {
  const metadata = authUser.user_metadata || {};
  return sendJson(res, 200, {
    status: appUser ? appUser.status : 'unregistered',
    email: authUser.email || null,
    google_name: metadata.full_name || metadata.name || null,
    user: appUser ? pick(appUser) : null,
  });
}

// POST ?action=register  body: { display_name, branch }
//   まだ app_users に行が無い人だけ。status='pending' で登録する
async function handleRegister(req, res, { authUser, appUser }) {
  if (appUser) {
    return sendJson(res, 409, { error: 'すでに登録されています' });
  }
  const { display_name, branch } = req.body || {};
  // String#trim は全角スペース(U+3000)も除去する（DBのCHECK制約と同じ考え方）
  const name = typeof display_name === 'string' ? display_name.trim() : '';
  const nameLength = [...name].length;
  if (nameLength < 1 || nameLength > DISPLAY_NAME_MAX_LENGTH) {
    return sendJson(res, 400, { error: `表示名は1〜${DISPLAY_NAME_MAX_LENGTH}文字で入力してください` });
  }
  if (!BRANCHES.includes(branch)) {
    return sendJson(res, 400, { error: '所属支部を選択してください' });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('app_users')
    .insert({ id: authUser.id, display_name: name, branch, status: 'pending', last_login_at: new Date().toISOString() })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      return sendJson(res, 409, { error: 'すでに登録されています' });
    }
    throw error;
  }
  return sendJson(res, 201, pick(data));
}

// POST ?action=login
//   app_users に行がある人だけ last_login_at を更新する（未登録なら何もしない）
async function handleLogin(req, res, { appUser }) {
  if (appUser) {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('app_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', appUser.id);
    if (error) throw error;
  }
  return sendJson(res, 204, null);
}

// auth.users のメールアドレスを全件読む（既定は1ページ50件のため、1000件ずつ最後のページまで読む）
async function loadEmails() {
  const supabase = getSupabaseClient();
  const emails = new Map();
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: LIST_USERS_PER_PAGE });
    if (error) throw error;
    for (const user of data.users) emails.set(user.id, user.email || null);
    if (!data.nextPage || data.users.length === 0) break;
  }
  return emails;
}

// GET ?action=list
//   出力: { me: { kind }, users: [...] }。自分の権限範囲のユーザーだけ（自分自身は含めない）
async function handleList(req, res, { appUser }) {
  const kind = adminKind(appUser);
  if (!kind) {
    return sendJson(res, 403, { error: 'ユーザー管理は管理者のみ利用できます' });
  }

  const supabase = getSupabaseClient();
  const [regionOf, usersResult, emails] = await Promise.all([
    loadRegionOf(),
    supabase.from('app_users').select('*').order('created_at', { ascending: true }),
    loadEmails(),
  ]);
  if (usersResult.error) throw usersResult.error;

  const users = usersResult.data
    .filter((target) => canManageTarget(appUser, target, regionOf))
    .map((target) => ({
      ...pick(target),
      email: emails.get(target.id) || null,
      can_set_scope: canSetScope(appUser, target, regionOf),
    }));
  return sendJson(res, 200, { me: { kind }, users });
}

// POST ?action=update  body: { target_id, op: 'approve'|'disable'|'enable'|'set_scope', admin_scope? }
//   ・approve  : pending → active。approved_at / approved_by を記録する
//   ・disable  : pending / active → disabled
//   ・enable   : disabled → active。approved_at / approved_by は上書きしない
//               （一度も承認されずに無効化された人だけは、ここで初めて記録する）
//   ・set_scope: active の相手の admin_scope を null / 'branch' / 'region' にする（グランドマスター・県連管理者のみ）
//   状態を条件にした更新にしているため、ほかの管理者と同時に操作しても二重に処理されない（0行なら409）
async function handleUpdate(req, res, { appUser }) {
  const kind = adminKind(appUser);
  if (!kind) {
    return sendJson(res, 403, { error: 'ユーザー管理は管理者のみ利用できます' });
  }

  const { target_id, op, admin_scope } = req.body || {};
  if (typeof target_id !== 'string' || !target_id) {
    return sendJson(res, 400, { error: '対象のユーザーを指定してください' });
  }

  const supabase = getSupabaseClient();
  const regionOf = await loadRegionOf();
  const { data: target, error: targetError } = await supabase
    .from('app_users')
    .select('*')
    .eq('id', target_id)
    .maybeSingle();
  if (targetError) {
    if (targetError.code === '22P02') return sendJson(res, 400, { error: '対象のユーザーの指定が正しくありません' });
    throw targetError;
  }
  // 権限範囲外のユーザーは、存在しないものとして扱う（範囲外の人の有無を知らせない）
  if (!target || !canManageTarget(appUser, target, regionOf)) {
    return sendJson(res, 404, { error: 'ユーザーが見つかりません' });
  }

  const now = new Date().toISOString();
  let query;
  if (op === 'approve') {
    query = supabase
      .from('app_users')
      .update({ status: 'active', approved_at: now, approved_by: appUser.id })
      .eq('id', target.id)
      .eq('status', 'pending');
  } else if (op === 'disable') {
    query = supabase
      .from('app_users')
      .update({ status: 'disabled' })
      .eq('id', target.id)
      .in('status', ['pending', 'active']);
  } else if (op === 'enable') {
    const updates = { status: 'active' };
    if (!target.approved_at) {
      updates.approved_at = now;
      updates.approved_by = appUser.id;
    }
    query = supabase.from('app_users').update(updates).eq('id', target.id).eq('status', 'disabled');
  } else if (op === 'set_scope') {
    if (!ADMIN_SCOPES.includes(admin_scope)) {
      return sendJson(res, 400, { error: '管理者の種類が正しくありません' });
    }
    if (!canSetScope(appUser, target, regionOf)) {
      return sendJson(res, 403, { error: '管理者の種類を変更する権限がありません' });
    }
    query = supabase
      .from('app_users')
      .update({ admin_scope })
      .eq('id', target.id)
      .eq('status', 'active');
  } else {
    return sendJson(res, 400, { error: '操作の種類が正しくありません' });
  }

  // 権限判定に使った相手の支部・管理者の種類が、判定後にほかの管理者に変えられていたら更新しない
  query = query.eq('branch', target.branch).eq('is_admin', target.is_admin);
  query = target.admin_scope === null ? query.is('admin_scope', null) : query.eq('admin_scope', target.admin_scope);

  const { data, error } = await query.select();
  if (error) throw error;
  if (data.length === 0) {
    return sendJson(res, 409, { error: 'このユーザーの状態が変わりました。画面を読み直してから操作してください' });
  }
  return sendJson(res, 200, pick(data[0]));
}
