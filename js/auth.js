// Googleログイン（Supabase Auth）の共通処理。スケジュール・日程調整・備品管理・候補管理・ユーザー管理の各画面で使う。
// ログインはGoogleだけ（共通パスワードのログインは段階5で廃止した）。
import { getSupabaseClient } from './supabase-client.js';
import { BRANCHES, REGION_OF_BRANCH } from './branches.js';

// Googleから戻ってきた直後に1回だけ「最終ログイン日時」を記録するための目印（ページをまたいで残るようsessionStorage）
const GOOGLE_LOGIN_PENDING_KEY = 'aichi-schedule:googleLoginPending';
// APIが401を返してログイン画面に戻すときに、ログイン画面に出す文言（読み直しをまたぐためsessionStorage）
const LOGIN_MESSAGE_KEY = 'aichi-schedule:loginMessage';
// 共通パスワードの時期に端末に保存していた値（パスワード・権限・手入力の名前）。ページを開いたときに消す
const LEGACY_LOGIN_KEYS = ['aichi-schedule:password', 'aichi-schedule:role', 'aichi-schedule:name'];

// このファイルを読み込んだ時点（＝どの画面も開いた直後）で、共通パスワードの時期の値を消す
try {
  for (const key of LEGACY_LOGIN_KEYS) localStorage.removeItem(key);
} catch (err) {
  // 保存領域が使えない環境でも画面は続ける
}
// Googleから戻ってきたときにURLに付く値（PKCEのcodeと、失敗時のerror）。処理後にURLから消す
const OAUTH_URL_PARAMS = ['code', 'error', 'error_code', 'error_description'];

const KIND_LABELS = { grand: 'システム管理者', region: '県連管理者', branch: '支部管理者' };

// 管理者の種類（api/_lib/user-auth.js の adminKind と同じ判定）
export function adminKindOf(user) {
  if (!user || user.status !== 'active') return null;
  if (user.is_admin) return 'grand';
  if (user.admin_scope === 'region') return 'region';
  if (user.admin_scope === 'branch') return 'branch';
  return null;
}

// ヘッダーに出す権限の表示。管理者の種類があればそれを、なければ「一般」
export function roleLabelOf(user) {
  return KIND_LABELS[adminKindOf(user)] || '一般';
}

// APIでの権限（api/_lib/auth.js の resolveActor の actor.role と同じ当てはめ。'admin' = システム管理者）
export function legacyRoleOf(user) {
  return user && user.is_admin ? 'admin' : 'user';
}

// ===================== 画面での権限判定（api/_lib/permissions.js と同じ考え方） =====================
// ボタンの表示・選択肢の絞り込みに使う。本当の判定は API 側で行う。
// session: 各画面の state（googleUser = ログインしている人の app_users の行 を持つ）

// Googleの県連管理者の、自分の県連の支部
export function regionBranchesOf(user) {
  const region = user ? REGION_OF_BRANCH[user.branch] : null;
  return region ? BRANCHES.filter((b) => REGION_OF_BRANCH[b] === region) : [];
}

// その支部のデータを管理できる管理者か（システム管理者は全支部、県連管理者は自分の県連内）
export function canManageBranchData(session, branch) {
  const user = session.googleUser;
  const kind = adminKindOf(user);
  if (kind === 'grand') return true;
  if (kind === 'region') return regionBranchesOf(user).includes(branch);
  return false;
}

// 県連管理者を含め、データを管理できる管理者か（候補管理・CSV出力のボタンを出すかどうか）
export function isDataManager(session) {
  const kind = adminKindOf(session.googleUser);
  return kind === 'grand' || kind === 'region';
}

// 備品を新規登録できるか（ログインしている有効な利用者は全員）
export function canCreateEquipment(session) {
  return Boolean(session.googleUser);
}

// 行に対して本人（または管理者）として操作できるか
//   row.branch: その行の支部 / row.userIds: 本人のユーザーID
//   ・IDが入っている行: 本人か、その支部を管理できる管理者
//   ・IDが空欄の行（移行前の行）: その支部を管理できる管理者だけ
export function canActOnRowFront(session, row) {
  if (canManageBranchData(session, row.branch)) return true;
  const ids = (row.userIds || []).filter(Boolean);
  return Boolean(session.googleUser) && ids.includes(session.googleUser.id);
}

// 参加・回答の行の本人か（管理者かどうかは見ない。「あなた：参加」などの表示に使う）
export function isMyParticipation(session, row) {
  return Boolean(session.googleUser) && row.participant_user_id === session.googleUser.id;
}

// Googleのセッションがあれば、最新のアクセストークンで Authorization ヘッダーを作る。
// 呼ぶたびに getSession() で取り直す（期限が近ければ supabase-js が更新したものが返る）
export async function getAuthHeaders() {
  const supabase = await getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const token = data && data.session ? data.session.access_token : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// APIが401（ログインしていない・トークンが無効）を返したときに、ログイン画面に戻す。
// この端末のGoogleセッションを消してページを読み直し、ログイン画面に文言を出す
export async function redirectToLogin(message = 'ログインし直してください') {
  try {
    sessionStorage.setItem(LOGIN_MESSAGE_KEY, message);
    await signOutLocal();
  } catch (err) {
    console.error(err);
  } finally {
    location.reload();
  }
}

// 段階5 ⑤: 表の読み取りは「ログインしている有効な人」だけ（RLS）。ログインが切れた人・無効にされた人の読み取りは、
// エラーにならず 0 件で返るため、そのままだと「一覧が空」に見える。
// 画面が直接読んだ結果が 0 件（見つからない）のときにこれを呼び、本当に読める状態かを確かめる。
//   有効 → true（本当に 0 件）
//   ログインが切れている → ログイン画面に戻す（redirectToLogin）。false
//   承認待ち・無効・未登録 → ページを読み直す（開いたときの確認で、利用できない旨の画面が出る）。false
// 確かめられなかったとき（通信の失敗、migration 0027 の前で関数が無いなど）は true を返し、今までどおり 0 件として出す。
// 1分以内に「有効」と確かめていれば、もう一度は聞かない（予定の無い日を続けて開いたときに毎回聞かないため）
const READ_ACCESS_CONFIRM_TTL_MS = 60 * 1000;
let readAccessConfirmedAt = 0;

export async function confirmReadAccess() {
  if (Date.now() - readAccessConfirmedAt < READ_ACCESS_CONFIRM_TTL_MS) return true;
  try {
    const supabase = await getSupabaseClient();
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData || !sessionData.session) {
      redirectToLogin();
      return false;
    }
    const { data, error, status } = await supabase.rpc('is_active_user');
    if (status === 401) {
      redirectToLogin();
      return false;
    }
    if (error) {
      console.error(error);
      return true;
    }
    if (data === true) {
      readAccessConfirmedAt = Date.now();
      return true;
    }
    // 有効ではない。API の me で今の状態を確かめ、有効でなければ読み直して、その状態の画面を出す
    let me = null;
    try {
      me = await usersApi('me', 'GET');
    } catch (err) {
      if (err.status === 401) {
        redirectToLogin();
        return false;
      }
      console.error(err);
      return true;
    }
    if (me && me.status === 'active') return true; // 判定が食い違ったときは読み直さない（読み直しを繰り返さないため）
    location.reload();
    return false;
  } catch (err) {
    console.error(err);
    return true;
  }
}

// api/users.js を呼ぶ（トークン必須）。me・login 以外で401なら、ログイン画面に戻す
// （me の401は loadGoogleAccount がログイン画面を出すので、ここでは戻さない）
export async function usersApi(action, method, body) {
  const options = { method, headers: await getAuthHeaders() };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/users?action=${encodeURIComponent(action)}`, options);
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && action !== 'me' && action !== 'login') redirectToLogin();
    const err = new Error((data && data.error) || `エラーが発生しました (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// チャットワーク・LINE等のアプリ内ブラウザか（Googleはアプリ内ブラウザでのログインを拒否するため）
export function isInAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/Line\/|FBAN|FBAV|Instagram|Chatwork|MicroMessenger|KAKAOTALK/i.test(ua)) return true;
  if (/Android/i.test(ua) && /; wv\)/.test(ua)) return true; // AndroidのWebView
  // iOSのアプリ内ブラウザ（WKWebView）はUAに「Safari/」が付かない（SafariやiOS版Chromeには付く）
  if (/iPhone|iPad|iPod/i.test(ua) && !/Safari\//.test(ua)) return true;
  return false;
}

function showLoginError(message) {
  const el = document.getElementById('login-error');
  if (el) el.textContent = message;
}

// ログイン画面の「Googleでログイン」ボタンとアプリ内ブラウザの案内を用意する（各画面の初期化で1回呼ぶ）
export function setupGoogleLogin() {
  const btn = document.getElementById('google-login-btn');
  const note = document.getElementById('inapp-browser-note');
  if (note) note.classList.toggle('hidden', !isInAppBrowser());
  // APIの401でログイン画面に戻ってきたときの文言
  const message = sessionStorage.getItem(LOGIN_MESSAGE_KEY);
  if (message) {
    sessionStorage.removeItem(LOGIN_MESSAGE_KEY);
    showLoginError(message);
  }
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    showLoginError('');
    try {
      await startGoogleLogin();
    } catch (err) {
      console.error(err);
      showLoginError('Googleログインを開始できませんでした。時間をおいて再度お試しください');
      btn.disabled = false;
    }
  });
}

// Googleの認証画面へ移動する。戻り先は今のページ（?event= や ?id= を含む。#以降は除く）
async function startGoogleLogin() {
  sessionStorage.setItem(GOOGLE_LOGIN_PENDING_KEY, '1');
  const supabase = await getSupabaseClient();
  const redirectTo = `${location.origin}${location.pathname}${location.search}`;
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) {
    sessionStorage.removeItem(GOOGLE_LOGIN_PENDING_KEY);
    throw error;
  }
}

// Googleから戻ってきたときにURLに付いた code / error を消す。失敗して戻ってきた場合は案内を出す
function consumeOAuthParams() {
  const url = new URL(location.href);
  const errorDescription = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (!OAUTH_URL_PARAMS.some((key) => url.searchParams.has(key))) return;
  for (const key of OAUTH_URL_PARAMS) url.searchParams.delete(key);
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  if (errorDescription) {
    sessionStorage.removeItem(GOOGLE_LOGIN_PENDING_KEY);
    showLoginError('Googleログインに失敗しました。もう一度お試しください');
  }
}

// ページを開いたときに、Googleのセッションがあれば利用者の状態を調べる。
// 返り値: null = Googleでログインしていない / { status, email, google_name, user }（api/users.js の me と同じ形）
// Googleから戻ってきた直後なら、最終ログイン日時も記録する
export async function loadGoogleAccount() {
  const supabase = await getSupabaseClient(); // 作成時に URL の ?code= を読み取り、セッションに交換する
  const { data } = await supabase.auth.getSession(); // 交換が終わるまで待ってから返る
  consumeOAuthParams();
  if (!data || !data.session) return null;

  if (sessionStorage.getItem(GOOGLE_LOGIN_PENDING_KEY)) {
    sessionStorage.removeItem(GOOGLE_LOGIN_PENDING_KEY);
    try {
      await usersApi('login', 'POST');
    } catch (err) {
      console.error('最終ログイン日時の記録に失敗:', err); // 記録に失敗してもログイン自体は続ける
    }
  }

  try {
    return await usersApi('me', 'GET');
  } catch (err) {
    if (err.status === 401) {
      // トークンが無効（削除されたユーザー等）。セッションを捨ててログイン画面に戻す
      await signOutLocal();
      showLoginError('ログインし直してください');
      return null;
    }
    throw err;
  }
}

// この端末のGoogleセッションだけを消す（ほかの端末のログインは消さない）
export async function signOutLocal() {
  const supabase = await getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  if (data && data.session) {
    await supabase.auth.signOut({ scope: 'local' });
  }
}

// Googleのログアウト。画面の状態を確実に初期化するため、ログアウト後にページを読み直す
export async function googleLogout() {
  try {
    await signOutLocal();
  } finally {
    location.reload();
  }
}

// ヘッダーの名前欄に、Googleの表示名を出す（固定表示。表示名の変更はユーザー管理で管理者が行う）
export function lockHeaderName(els, user) {
  els.nameDisplayValue.textContent = user.display_name;
}

// ===================== 登録・承認待ち・無効の画面 =====================

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function gateShell(title) {
  const screen = el('section', 'login-screen account-gate');
  const card = el('div', 'login-card');
  card.appendChild(el('h1', 'app-title', '愛知活動スケジュール＆備品管理'));
  card.appendChild(el('h2', 'account-gate-title', title));
  screen.appendChild(card);
  document.body.appendChild(screen);
  return card;
}

function logoutButton() {
  const btn = el('button', 'btn btn-outline', 'ログアウト');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    googleLogout();
  });
  return btn;
}

function emailLine(account) {
  return el('p', 'account-gate-email', account.email ? `ログイン中: ${account.email}` : '');
}

// status が active 以外のときに出す画面（unregistered / pending / disabled）
export function showAccountGate(account) {
  if (account.status === 'unregistered') {
    renderRegisterForm(account);
  } else if (account.status === 'pending') {
    const card = gateShell('承認待ちです');
    card.appendChild(
      el('p', 'account-gate-text', '登録を受け付けました。所属の支部または県連の管理者が承認すると、使えるようになります。')
    );
    card.appendChild(emailLine(account));
    const actions = el('div', 'account-gate-actions');
    const reload = el('button', 'btn btn-primary', '承認されたか確認する');
    reload.type = 'button';
    reload.addEventListener('click', () => location.reload());
    actions.append(reload, logoutButton());
    card.appendChild(actions);
  } else {
    const card = gateShell('このアカウントは利用できません');
    card.appendChild(
      el('p', 'account-gate-text', 'このアカウントは無効になっています。所属の支部または県連の管理者にお問い合わせください。')
    );
    card.appendChild(emailLine(account));
    const actions = el('div', 'account-gate-actions');
    actions.appendChild(logoutButton());
    card.appendChild(actions);
  }
}

function renderRegisterForm(account) {
  const card = gateShell('利用登録');
  card.appendChild(
    el('p', 'account-gate-text', '表示名と所属支部を入力してください。登録後、管理者の承認を待つ状態になります。')
  );
  card.appendChild(emailLine(account));

  const form = el('form', 'login-form account-gate-form');
  const nameLabel = el('label', '', '表示名（予定や参加者の一覧に出る名前）');
  nameLabel.htmlFor = 'register-display-name';
  const nameInput = el('input');
  nameInput.id = 'register-display-name';
  nameInput.type = 'text';
  nameInput.maxLength = 50;
  nameInput.required = true;
  nameInput.value = account.google_name || '';

  const branchLabel = el('label', '', '所属支部');
  branchLabel.htmlFor = 'register-branch';
  const branchSelect = el('select');
  branchSelect.id = 'register-branch';
  branchSelect.required = true;
  branchSelect.appendChild(new Option('-- 支部を選択 --', ''));
  for (const branch of BRANCHES) branchSelect.appendChild(new Option(branch, branch));

  const error = el('p', 'form-error');
  const submit = el('button', 'btn btn-primary', '登録する');
  submit.type = 'submit';

  form.append(nameLabel, nameInput, branchLabel, branchSelect, submit, error);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const displayName = nameInput.value.trim();
    if (!displayName) {
      error.textContent = '表示名を入力してください';
      return;
    }
    if (!branchSelect.value) {
      error.textContent = '所属支部を選択してください';
      return;
    }
    submit.disabled = true;
    try {
      await usersApi('register', 'POST', { display_name: displayName, branch: branchSelect.value });
      location.reload(); // 読み直すと「承認待ち」の画面になる
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });
  card.appendChild(form);

  const actions = el('div', 'account-gate-actions');
  actions.appendChild(logoutButton());
  card.appendChild(actions);
}
