// ユーザー管理画面（Googleでログインした管理者だけが使える）。
// 表示される・操作できるのは、自分の権限範囲のユーザーだけ（範囲の判定は api/users.js 側で行う）。
// 画面の支部の絞り込み・支部管理者の表示・承認待ちの人数は、api/users.js の list が返す内容だけで作っている
import { BRANCHES, REGION_OF_BRANCH } from './branches.js';
import { loadGoogleAccount, showAccountGate, googleLogout, usersApi, adminKindOf, roleLabelOf } from './auth.js';

const ALL = 'all';
const SELECTED_BRANCH_KEY = 'aichi-schedule:usersBranch';

const STATUS_GROUPS = [
  { status: 'pending', title: '承認待ち' },
  { status: 'active', title: '有効' },
  { status: 'disabled', title: '無効' },
];
const SCOPE_OPTIONS = [
  { value: '', label: '一般' },
  { value: 'branch', label: '支部管理者' },
  { value: 'region', label: '県連管理者' },
];
const SCOPE_TEXT = {
  grand: 'システム管理者として、全支部のユーザーを管理できます。',
  region: '県連管理者として、自分の県連内の支部のユーザーを管理できます。',
  branch: '支部管理者として、自分の支部の一般ユーザーの承認・無効化ができます。',
};

const state = {
  me: null, // 自分（app_usersの行）
  kind: null, // 'grand' | 'region' | 'branch'
  users: [], // list の結果（自分の権限範囲のユーザー。自分自身は含まれない）
  branch: ALL, // 選んでいる支部（ALL = すべて）
  // アコーディオンの開閉。承認待ちは最初から開き、有効・無効は閉じておく。操作のあとの読み直しでも保つ
  open: { pending: true, active: false, disabled: false },
};

const els = {
  bootLoading: document.getElementById('boot-loading'),
  app: document.getElementById('app'),
  roleDot: document.getElementById('role-dot'),
  roleText: document.getElementById('role-text'),
  nameDisplayValue: document.getElementById('name-display-value'),
  logoutBtn: document.getElementById('logout-btn'),
  notice: document.getElementById('users-notice'),
  noticeText: document.getElementById('users-notice-text'),
  branchPanel: document.getElementById('users-branch-panel'),
  branchSelect: document.getElementById('users-branch-select'),
  branchAdmins: document.getElementById('users-branch-admins'),
  panel: document.getElementById('users-panel'),
  scopeText: document.getElementById('users-scope-text'),
  reloadBtn: document.getElementById('users-reload-btn'),
  list: document.getElementById('users-list'),
};

const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

init();

async function init() {
  els.logoutBtn.addEventListener('click', () => {
    els.logoutBtn.disabled = true;
    googleLogout();
  });
  els.reloadBtn.addEventListener('click', () => loadList());
  els.branchSelect.addEventListener('change', () => {
    state.branch = els.branchSelect.value;
    saveSelectedBranch(state.branch);
    render();
  });

  let account = null;
  try {
    account = await loadGoogleAccount();
  } catch (err) {
    console.error(err);
    return showNotice('ログイン状態を確認できませんでした。時間をおいて再度お試しください');
  }
  els.bootLoading.classList.add('hidden');

  if (!account) {
    return showNotice('ユーザー管理は、Googleでログインした管理者だけが使えます。スケジュール画面の「Googleでログイン」からログインしてください。');
  }
  if (account.status !== 'active') {
    showAccountGate(account);
    return;
  }

  els.app.classList.remove('hidden');
  els.nameDisplayValue.textContent = account.user.display_name;
  els.roleText.textContent = roleLabelOf(account.user);
  els.roleDot.classList.toggle('admin', Boolean(account.user.is_admin));

  const kind = adminKindOf(account.user);
  if (!kind) {
    showNotice('ユーザー管理は、管理者だけが使えます。');
    return;
  }
  state.me = account.user;
  state.kind = kind;
  state.branch = initialBranch();
  els.scopeText.textContent = SCOPE_TEXT[kind];
  els.branchPanel.classList.remove('hidden');
  els.panel.classList.remove('hidden');
  await loadList();
}

function showNotice(text) {
  els.bootLoading.classList.add('hidden');
  els.app.classList.remove('hidden');
  els.noticeText.textContent = text;
  els.notice.classList.remove('hidden');
  els.branchPanel.classList.add('hidden');
  els.panel.classList.add('hidden');
}

// ===================== 支部の選択 =====================

// 自分の権限で選べる支部（ALL を含む）
//   システム管理者: すべて＋18支部 / 県連管理者: すべて（自分の県連内）＋自分の県連の支部 / 支部管理者: 自分の支部だけ
function branchChoices() {
  if (state.kind === 'grand') return [ALL, ...BRANCHES];
  if (state.kind === 'region') {
    const region = REGION_OF_BRANCH[state.me.branch];
    return [ALL, ...BRANCHES.filter((b) => REGION_OF_BRANCH[b] === region)];
  }
  return [state.me.branch];
}

// 最後に選んだ支部。権限外（または未保存）なら、すべて（支部管理者は自分の支部）
function initialBranch() {
  const choices = branchChoices();
  let saved = null;
  try {
    saved = localStorage.getItem(SELECTED_BRANCH_KEY);
  } catch (err) {
    saved = null;
  }
  return choices.includes(saved) ? saved : choices[0];
}

function saveSelectedBranch(branch) {
  try {
    localStorage.setItem(SELECTED_BRANCH_KEY, branch);
  } catch (err) {
    // 保存できなくても表示は続ける
  }
}

// 選択肢を作り直す（承認待ちの人数が変わるため、読み直すたびに作る）。選んでいる支部は保つ
function renderBranchSelect() {
  const pendingCount = (branch) =>
    state.users.filter((u) => u.status === 'pending' && (branch === ALL || u.branch === branch)).length;
  const allLabel = state.kind === 'region' ? 'すべて（自分の県連内）' : 'すべて';

  els.branchSelect.innerHTML = '';
  for (const branch of branchChoices()) {
    const count = pendingCount(branch);
    const name = branch === ALL ? allLabel : branch;
    els.branchSelect.appendChild(new Option(count > 0 ? `${name}（承認待ち${count}）` : name, branch));
  }
  els.branchSelect.value = state.branch;
  els.branchSelect.disabled = state.kind === 'branch'; // 支部管理者は自分の支部だけ（変更できない）
}

// 選んだ支部の支部管理者（有効な人）を全員。list に自分自身は含まれないため、自分が該当すれば加える。
// 支部管理者の画面でも、同じ支部のほかの管理者は list に「見るだけ」（can_manage: false）で含まれる
function branchAdminNames(branch) {
  const names = state.users
    .filter((u) => u.status === 'active' && u.admin_scope === 'branch' && u.branch === branch)
    .map((u) => u.display_name);
  if (state.me.admin_scope === 'branch' && state.me.branch === branch) names.unshift(state.me.display_name);
  return names;
}

function renderBranchAdmins() {
  if (state.branch === ALL) {
    els.branchAdmins.classList.add('hidden');
    return;
  }
  const names = branchAdminNames(state.branch);
  els.branchAdmins.textContent = `支部管理者：${names.length > 0 ? names.join('、') : 'なし'}`;
  els.branchAdmins.classList.remove('hidden');
}

// ===================== 一覧 =====================

async function loadList() {
  els.list.innerHTML = '';
  els.list.appendChild(hint('読み込み中…'));
  els.reloadBtn.disabled = true;
  try {
    const { users } = await usersApi('list', 'GET');
    state.users = users;
    render();
  } catch (err) {
    els.list.innerHTML = '';
    els.list.appendChild(hint(err.message));
  } finally {
    els.reloadBtn.disabled = false;
  }
}

function render() {
  renderBranchSelect();
  renderBranchAdmins();
  renderList();
}

function hint(text) {
  const p = document.createElement('p');
  p.className = 'hint-text';
  p.textContent = text;
  return p;
}

function renderList() {
  const showBranch = state.branch === ALL;
  const users = showBranch ? state.users : state.users.filter((u) => u.branch === state.branch);

  els.list.innerHTML = '';
  for (const group of STATUS_GROUPS) {
    const rows = users.filter((u) => u.status === group.status);

    const details = document.createElement('details');
    details.className = `users-group users-group-${group.status}`;
    details.open = state.open[group.status];
    details.addEventListener('toggle', () => {
      state.open[group.status] = details.open;
    });

    const summary = document.createElement('summary');
    summary.className = 'users-group-summary';
    const title = document.createElement('span');
    title.className = 'users-group-title';
    title.textContent = `${group.title}（${rows.length}人）`;
    const chevron = document.createElement('span');
    chevron.className = 'users-group-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '▼';
    summary.append(title, chevron);
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'users-group-body';
    if (rows.length === 0) {
      body.appendChild(hint('該当するユーザーはいません'));
    } else {
      // 承認待ちは登録の古い順（待たせている順）、それ以外は表示名順
      const sorted =
        group.status === 'pending'
          ? rows
          : [...rows].sort((a, b) => a.display_name.localeCompare(b.display_name, 'ja'));
      for (const user of sorted) body.appendChild(createUserCard(user, showBranch));
    }
    details.appendChild(body);
    els.list.appendChild(details);
  }
}

function formatDateTime(value) {
  return value ? dateTimeFormatter.format(new Date(value)) : 'なし';
}

// showBranch: 「すべて」を表示しているときだけ、行に支部名を出す
function createUserCard(user, showBranch) {
  const card = document.createElement('article');
  card.className = 'user-card';

  const head = document.createElement('div');
  head.className = 'user-card-head';
  const name = document.createElement('span');
  name.className = 'user-card-name';
  name.textContent = user.display_name;
  head.appendChild(name);
  const kindLabel = user.is_admin ? 'システム管理者' : user.admin_scope === 'region' ? '県連管理者' : user.admin_scope === 'branch' ? '支部管理者' : '';
  if (kindLabel) {
    const badge = document.createElement('span');
    badge.className = 'user-card-badge';
    badge.textContent = kindLabel;
    head.appendChild(badge);
  }
  // 支部管理者の画面に出る、同じ支部のほかの管理者（can_manage: false）は見るだけ
  const viewOnly = user.can_manage === false;
  if (viewOnly) {
    card.classList.add('is-view-only');
    const note = document.createElement('span');
    note.className = 'user-card-view-only';
    note.textContent = '見るだけ';
    head.appendChild(note);
  }
  card.appendChild(head);

  const meta = document.createElement('dl');
  meta.className = 'user-card-meta';
  const rows = [
    ['登録日', dateFormatter.format(new Date(user.created_at))],
    ['最終ログイン', formatDateTime(user.last_login_at)],
  ];
  if (!viewOnly) rows.unshift(['メール', user.email || '（不明）']); // 見るだけの行はメールアドレスが返らない
  if (showBranch) rows.unshift(['支部', user.branch]);
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    meta.append(dt, dd);
  }
  card.appendChild(meta);
  if (viewOnly) return card; // 承認・無効化などのボタンは出さない

  const actions = document.createElement('div');
  actions.className = 'user-card-actions';
  if (user.status === 'pending') {
    actions.appendChild(actionButton('承認する', 'btn btn-primary btn-small', user, 'approve', `${user.display_name}さん（${user.branch}）を承認しますか？`));
    actions.appendChild(actionButton('無効にする', 'btn btn-muted btn-small', user, 'disable', `${user.display_name}さんを無効にしますか？（使えなくなります）`));
  } else if (user.status === 'active') {
    actions.appendChild(actionButton('無効にする', 'btn btn-muted btn-small', user, 'disable', `${user.display_name}さんを無効にしますか？（使えなくなります）`));
  } else {
    actions.appendChild(actionButton('再有効化する', 'btn btn-outline btn-small', user, 'enable', `${user.display_name}さんを再び使えるようにしますか？`));
  }
  card.appendChild(actions);

  // 管理者の種類の変更（システム管理者・県連管理者だけ。有効なユーザーのみ）
  if (user.status === 'active' && user.can_set_scope && !user.is_admin) {
    card.appendChild(createScopeEditor(user));
  }
  // 支部の変更（システム管理者・県連管理者だけ）と表示名の変更（操作できる相手なら全員）。状態は問わない
  if (user.can_set_branch) {
    card.appendChild(createBranchEditor(user));
  }
  card.appendChild(createNameEditor(user));
  return card;
}

// 自分が移動させられる支部（相手の今の支部は除く）
//   システム管理者: 18支部すべて / 県連管理者: 自分の県連内の支部だけ（東西をまたぐ移動はシステム管理者だけ）
function branchDestinations(user) {
  const region = REGION_OF_BRANCH[state.me.branch];
  const choices = state.kind === 'grand' ? BRANCHES : BRANCHES.filter((b) => REGION_OF_BRANCH[b] === region);
  return choices.filter((b) => b !== user.branch);
}

function createBranchEditor(user) {
  const wrap = document.createElement('div');
  wrap.className = 'user-card-scope user-card-edit';

  const label = document.createElement('label');
  label.textContent = '支部';
  const select = document.createElement('select');
  select.className = 'user-card-branch-select';
  select.appendChild(new Option(`${user.branch}（今の支部）`, ''));
  for (const branch of branchDestinations(user)) select.appendChild(new Option(branch, branch));
  label.appendChild(select);

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-outline btn-small';
  apply.textContent = '支部を変更';
  apply.addEventListener('click', async () => {
    const next = select.value;
    if (!next) {
      alert('移動先の支部を選んでください');
      return;
    }
    const notes = [];
    if (user.admin_scope === 'branch') notes.push('支部管理者の指定が外れます。');
    if (user.admin_scope === 'region' && REGION_OF_BRANCH[next] !== REGION_OF_BRANCH[user.branch]) {
      notes.push('県連管理者の指定が外れます。');
    }
    const message = [`${user.display_name}さんの支部を「${user.branch}」から「${next}」に変更しますか？`, ...notes].join('\n');
    if (!confirm(message)) return;
    apply.disabled = true;
    await runUpdate({ target_id: user.id, op: 'set_branch', branch: next });
    apply.disabled = false;
  });

  wrap.append(label, apply);
  return wrap;
}

function createNameEditor(user) {
  const wrap = document.createElement('div');
  wrap.className = 'user-card-scope user-card-edit';

  const label = document.createElement('label');
  label.textContent = '名前';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'user-card-name-input';
  input.value = user.display_name;
  input.maxLength = 50;
  input.setAttribute('aria-label', `${user.display_name}さんの表示名`);
  label.appendChild(input);

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-outline btn-small';
  apply.textContent = '名前を変更';
  apply.addEventListener('click', async () => {
    const next = input.value.trim();
    if (!next) {
      alert('名前を入力してください');
      return;
    }
    if (next === user.display_name) {
      alert('今と同じ名前です');
      return;
    }
    const message = `${user.display_name}さんの表示名を「${next}」に変更しますか？\n（過去の予定や参加に残っている名前は変わりません）`;
    if (!confirm(message)) return;
    apply.disabled = true;
    await runUpdate({ target_id: user.id, op: 'set_name', display_name: next });
    apply.disabled = false;
  });

  wrap.append(label, apply);
  return wrap;
}

function actionButton(label, className, user, op, confirmMessage) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    if (!confirm(confirmMessage)) return;
    btn.disabled = true;
    await runUpdate({ target_id: user.id, op });
    btn.disabled = false;
  });
  return btn;
}

function createScopeEditor(user) {
  const wrap = document.createElement('div');
  wrap.className = 'user-card-scope';

  const label = document.createElement('label');
  label.textContent = '管理者の種類';
  const select = document.createElement('select');
  for (const option of SCOPE_OPTIONS) select.appendChild(new Option(option.label, option.value));
  select.value = user.admin_scope || '';
  label.appendChild(select);

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-outline btn-small';
  apply.textContent = '変更';
  apply.addEventListener('click', async () => {
    const next = select.value || null;
    if (next === (user.admin_scope || null)) return;
    const nextLabel = SCOPE_OPTIONS.find((o) => o.value === (next || '')).label;
    if (!confirm(`${user.display_name}さんを「${nextLabel}」にしますか？`)) return;
    apply.disabled = true;
    await runUpdate({ target_id: user.id, op: 'set_scope', admin_scope: next });
    apply.disabled = false;
  });

  wrap.append(label, apply);
  return wrap;
}

// 操作のあとは一覧を読み直す（選んでいる支部とアコーディオンの開閉は state に残っているため保たれる）
async function runUpdate(payload) {
  try {
    await usersApi('update', 'POST', payload);
  } catch (err) {
    alert(err.message);
  }
  await loadList();
}
