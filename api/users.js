const { getSupabaseClient } = require('./_lib/supabase');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES } = require('./_lib/branches');
const {
  getAuthUser,
  adminKind,
  loadRegionOf,
  canManageTarget,
  canSetScope,
  canSetBranch,
  canDeleteTarget,
} = require('./_lib/user-auth');

// Googleログインの利用者（app_users）に関するAPI。
// Vercel Hobbyプランのサーバーレス関数数上限（12個）のため、1ファイルにまとめてクエリ文字列(?action=)で分岐する。
//   GET  /api/users?action=me       : 自分の状態
//   POST /api/users?action=register : 初回登録（表示名・所属支部。status='pending'）
//   POST /api/users?action=login    : 最終ログイン日時の記録（Googleから戻った直後に1回だけ呼ぶ）
//   GET  /api/users?action=list     : ユーザー一覧（管理者のみ。自分の権限範囲のユーザーだけ）
//   POST /api/users?action=update   : 承認・無効化・再有効化・管理者の種類・支部・表示名の変更・削除（管理者のみ）
//   GET  /api/users?action=names&ids=a,b : 利用者の表示名（有効な利用者のみ。日程調整の「〇〇さんが決定」などの表示用）
// どれも Authorization: Bearer <Supabaseのアクセストークン> が必要。共通パスワードでは使えない。

const DISPLAY_NAME_MAX_LENGTH = 50;
const ADMIN_SCOPES = [null, 'branch', 'region'];
const LIST_USERS_PER_PAGE = 1000;
// 表示名の取得（action=names）で一度に受け付ける id の数
const NAMES_MAX_IDS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 一覧・更新で返す列（is_admin / admin_scope は画面での表示用）
const PUBLIC_COLUMNS = [
  'id', 'display_name', 'branch', 'status', 'is_admin', 'admin_scope',
  'created_at', 'approved_at', 'approved_by', 'last_login_at',
];

function pick(row) {
  return Object.fromEntries(PUBLIC_COLUMNS.map((key) => [key, row[key]]));
}

// 表示名の検証（登録と、管理者による変更で共通）。前後の空白を除いて1〜50文字。
// String#trim は全角スペース(U+3000)も除去する（DBのCHECK制約と同じ考え方）。返り値: 正しければ名前、違えば null
function normalizeDisplayName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  const length = [...name].length;
  return length >= 1 && length <= DISPLAY_NAME_MAX_LENGTH ? name : null;
}
const DISPLAY_NAME_ERROR = `表示名は1〜${DISPLAY_NAME_MAX_LENGTH}文字で入力してください`;

// app_users.id を参照している列（どれも外部キーは no action）。1件でもあれば、その人は削除できない
const USER_REFERENCES = [
  ['events', 'poster_user_id'],
  ['participants', 'participant_user_id'],
  ['participants', 'registered_by_user_id'],
  ['coordinations', 'created_by_user_id'],
  ['coordinations', 'decided_by_user_id'], // 決定した人（migration 0024）
  ['coordination_responses', 'participant_user_id'],
  ['coordination_responses', 'registered_by_user_id'],
  ['equipment', 'updated_by_user_id'],
  ['equipment', 'created_by_user_id'],
  ['equipment_history', 'moved_by_user_id'],
  ['app_users', 'approved_by'],
];
const HAS_RECORDS_MESSAGE = 'この人は予定や参加などの記録があるため削除できません。無効化してください';
const CHANGED_MESSAGE = 'このユーザーの状態が変わりました。画面を読み直してから操作してください';
const AUTH_DELETE_WARNING =
  'アプリの利用者からは削除しましたが、Googleのログイン情報の削除に失敗しました。' +
  'この人が次にログインすると登録画面に戻ります。必要ならSupabaseのAuthentication画面から削除してください';

module.exports = async (req, res) => {
  const { action } = req.query || {};
  const routes = {
    me: ['GET', handleMe],
    register: ['POST', handleRegister],
    login: ['POST', handleLogin],
    list: ['GET', handleList],
    update: ['POST', handleUpdate],
    names: ['GET', handleNames],
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
  const name = normalizeDisplayName(display_name);
  if (!name) {
    return sendJson(res, 400, { error: DISPLAY_NAME_ERROR });
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

// 支部管理者が一覧を開いたときに「見るだけ」で出す、同じ支部の管理者（支部管理者・県連管理者）。
// 支部管理者は何人でも置けるため、同じ支部のほかの管理者を画面に出せるようにしている。操作はできない（update の判定は変えない）
function isViewOnlyColleague(actor, target) {
  return (
    adminKind(actor) === 'branch' &&
    target.id !== actor.id &&
    !target.is_admin &&
    target.branch === actor.branch &&
    (target.admin_scope === 'branch' || target.admin_scope === 'region')
  );
}

// GET ?action=list
//   出力: { me: { kind }, users: [...] }。自分の権限範囲のユーザー（can_manage: true）。自分自身は含めない。
//   支部管理者には、同じ支部の管理者も can_manage: false（見るだけ）で含める。見るだけの行はメールアドレスを返さない
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

  const users = [];
  for (const target of usersResult.data) {
    if (canManageTarget(appUser, target, regionOf)) {
      users.push({
        ...pick(target),
        email: emails.get(target.id) || null,
        can_manage: true,
        can_set_scope: canSetScope(appUser, target, regionOf),
        can_set_branch: canSetBranch(appUser, target, regionOf),
        // 状態と権限だけで判定する（記録の有無は、削除のときに dry_run と本番で確かめる）
        can_delete: canDeleteTarget(appUser, target, regionOf),
      });
    } else if (isViewOnlyColleague(appUser, target)) {
      users.push({
        ...pick(target),
        email: null,
        can_manage: false,
        can_set_scope: false,
        can_set_branch: false,
        can_delete: false,
      });
    }
  }
  return sendJson(res, 200, { me: { kind }, users });
}

// POST ?action=update
//   body: { target_id, op: 'approve'|'disable'|'enable'|'set_scope'|'set_branch'|'set_name', admin_scope?, branch?, display_name? }
//   ・approve  : pending → active。approved_at / approved_by を記録する
//   ・disable  : pending / active → disabled
//   ・enable   : disabled → active。approved_at / approved_by は上書きしない
//               （一度も承認されずに無効化された人だけは、ここで初めて記録する）
//   ・set_scope: active の相手の admin_scope を null / 'branch' / 'region' にする（システム管理者・県連管理者のみ）
//   ・set_branch: 相手の支部を変える（状態は問わない）。システム管理者はどの支部へも、
//               県連管理者は自分の県連内の支部へだけ（canSetBranch）。支部管理者は admin_scope を null に戻す。
//               県連管理者は、県連が変わる移動（システム管理者だけができる）のときだけ admin_scope を null に戻す
//   ・set_name : 相手の表示名を変える（状態は問わない。範囲は承認・無効化と同じ canManageTarget）。
//               過去の予定・参加などに残っている名前（poster_name 等）は書き換えない
//   ・delete   : 相手を削除する（handleDeleteUser。dry_run: true なら判定と記録の確認だけで何も書き換えない）
//   状態を条件にした更新にしているため、ほかの管理者と同時に操作しても二重に処理されない（0行なら409）。
//   書き換えるのは app_users の対象の1行だけ（delete は auth.users の1行も）
async function handleUpdate(req, res, { appUser }) {
  const kind = adminKind(appUser);
  if (!kind) {
    return sendJson(res, 403, { error: 'ユーザー管理は管理者のみ利用できます' });
  }

  const { target_id, op, admin_scope, branch, display_name } = req.body || {};
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

  if (op === 'delete') {
    return handleDeleteUser(res, { appUser, target, regionOf, dryRun: req.body.dry_run === true });
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
  } else if (op === 'set_branch') {
    if (!canSetBranch(appUser, target, regionOf)) {
      return sendJson(res, 403, { error: '支部を変更する権限がありません' });
    }
    if (!BRANCHES.includes(branch)) {
      return sendJson(res, 400, { error: '支部を選択してください' });
    }
    if (branch === target.branch) {
      return sendJson(res, 400, { error: '今と同じ支部です' });
    }
    if (!canSetBranch(appUser, target, regionOf, branch)) {
      return sendJson(res, 403, { error: '東西の県連をまたぐ移動は、システム管理者だけができます' });
    }
    const updates = { branch };
    // 支部管理者は移動した支部の管理者にはしない。県連管理者も、県連が変わるなら指定を外す
    if (target.admin_scope === 'branch') updates.admin_scope = null;
    if (target.admin_scope === 'region' && regionOf(branch) !== regionOf(target.branch)) updates.admin_scope = null;
    query = supabase.from('app_users').update(updates).eq('id', target.id);
  } else if (op === 'set_name') {
    const name = normalizeDisplayName(display_name);
    if (!name) {
      return sendJson(res, 400, { error: DISPLAY_NAME_ERROR });
    }
    if (name === target.display_name) {
      return sendJson(res, 400, { error: '今と同じ名前です' });
    }
    // ほかの管理者が同時に名前を変えていたら更新しない
    query = supabase.from('app_users').update({ display_name: name }).eq('id', target.id).eq('display_name', target.display_name);
  } else {
    return sendJson(res, 400, { error: '操作の種類が正しくありません' });
  }

  // 権限判定に使った相手の支部・管理者の種類が、判定後にほかの管理者に変えられていたら更新しない
  query = query.eq('branch', target.branch).eq('is_admin', target.is_admin);
  query = target.admin_scope === null ? query.is('admin_scope', null) : query.eq('admin_scope', target.admin_scope);

  const { data, error } = await query.select();
  if (error) throw error;
  if (data.length === 0) {
    return sendJson(res, 409, { error: CHANGED_MESSAGE });
  }
  return sendJson(res, 200, pick(data[0]));
}

// GET ?action=names&ids=a,b
//   利用者の表示名 [{ id, display_name }]。有効な利用者だけが使える（承認待ち・無効・未登録は403）。
//   日程調整の画面は anon で読むため app_users（RLSで読めない）を結べない。決定した人の表示名はここで取る。
//   id は最大50件。形の正しくない id は無視する。見つからない id は返さない
async function handleNames(req, res, { appUser }) {
  if (!appUser || appUser.status !== 'active') {
    return sendJson(res, 403, { error: 'このアカウントは現在利用できません' });
  }
  const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => UUID_PATTERN.test(s)))];
  if (ids.length === 0) {
    return sendJson(res, 200, []);
  }
  if (ids.length > NAMES_MAX_IDS) {
    return sendJson(res, 400, { error: `idは${NAMES_MAX_IDS}件以内にしてください` });
  }
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('app_users').select('id, display_name').in('id', ids);
  if (error) throw error;
  return sendJson(res, 200, data || []);
}

// 相手が作った記録（app_users.id を参照している行）があるか。11列を同時に数える（どれもインデックスあり。approved_by は app_users 内）
async function hasUserRecords(supabase, userId) {
  const counts = await Promise.all(
    USER_REFERENCES.map(([table, column]) =>
      supabase.from(table).select('id', { count: 'exact', head: true }).eq(column, userId)
    )
  );
  for (const { count, error } of counts) {
    if (error) throw error;
    if (count > 0) return true;
  }
  return false;
}

// update の op='delete'（範囲外の404は呼び出し側で判定済み）
//   ・判定: システム管理者は画面から削除できない / 有効の人は先に無効化 / 支部管理者は承認待ちの一般だけ / 記録がある人は不可
//   ・dry_run: 上の判定と記録の確認だけを本番と同じに行い、何も書き換えない（200 { deletable: true, dry_run: true }）
//   ・本番: app_users の行 → auth.users の順に削除する（app_users.id が auth.users を参照しているため、この順しかない）。
//     app_users の削除は、判定に使った状態・支部・is_admin・admin_scope を条件にし、0行なら409。
//     事前確認をすり抜けて記録があった場合は、外部キー（no action）の違反（23503）で止まり409（auth は消さない）。
//     auth.users の削除だけ失敗した場合は、アプリからは削除できているため 200 に警告を付ける
//     （その人は次のログインで未登録＝登録画面に戻る。やり直しは Supabase の Authentication 画面から）
async function handleDeleteUser(res, { appUser, target, regionOf, dryRun }) {
  if (target.is_admin) {
    return sendJson(res, 403, { error: 'システム管理者は画面から削除できません' });
  }
  if (target.status === 'active') {
    return sendJson(res, 400, { error: '先に無効化してください' });
  }
  if (!canDeleteTarget(appUser, target, regionOf)) {
    return sendJson(res, 403, { error: '支部管理者が削除できるのは、承認待ちの一般ユーザーだけです' });
  }

  const supabase = getSupabaseClient();
  if (await hasUserRecords(supabase, target.id)) {
    return sendJson(res, 409, { error: HAS_RECORDS_MESSAGE });
  }
  if (dryRun) {
    return sendJson(res, 200, { deletable: true, dry_run: true });
  }

  let query = supabase
    .from('app_users')
    .delete()
    .eq('id', target.id)
    .eq('status', target.status)
    .eq('branch', target.branch)
    .eq('is_admin', target.is_admin);
  query = target.admin_scope === null ? query.is('admin_scope', null) : query.eq('admin_scope', target.admin_scope);
  const { data, error } = await query.select();
  if (error) {
    if (error.code === '23503') return sendJson(res, 409, { error: HAS_RECORDS_MESSAGE });
    throw error;
  }
  if (data.length === 0) {
    return sendJson(res, 409, { error: CHANGED_MESSAGE });
  }

  const { error: authError } = await supabase.auth.admin.deleteUser(target.id);
  if (authError && authError.status !== 404 && authError.code !== 'user_not_found') {
    console.error('users(delete): auth.users の削除に失敗:', authError);
    return sendJson(res, 200, { deleted: true, auth_deleted: false, warning: AUTH_DELETE_WARNING });
  }
  return sendJson(res, 200, { deleted: true, auth_deleted: true });
}
