// ユーザー管理画面（Googleでログインした管理者だけが使える）。
// 表示される・操作できるのは、自分の権限範囲のユーザーだけ（範囲の判定は api/users.js 側で行う）
import { loadGoogleAccount, showAccountGate, googleLogout, usersApi, adminKindOf, roleLabelOf } from './auth.js';

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
  grand: 'グランドマスターとして、全支部のユーザーを管理できます。',
  region: '県連管理者として、自分の県連内の支部のユーザーを管理できます。',
  branch: '支部管理者として、自分の支部の一般ユーザーの承認・無効化ができます。',
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
  els.scopeText.textContent = SCOPE_TEXT[kind];
  els.panel.classList.remove('hidden');
  await loadList();
}

function showNotice(text) {
  els.bootLoading.classList.add('hidden');
  els.app.classList.remove('hidden');
  els.noticeText.textContent = text;
  els.notice.classList.remove('hidden');
  els.panel.classList.add('hidden');
}

async function loadList() {
  els.list.innerHTML = '';
  els.list.appendChild(hint('読み込み中…'));
  els.reloadBtn.disabled = true;
  try {
    const { users } = await usersApi('list', 'GET');
    renderList(users);
  } catch (err) {
    els.list.innerHTML = '';
    els.list.appendChild(hint(err.message));
  } finally {
    els.reloadBtn.disabled = false;
  }
}

function hint(text) {
  const p = document.createElement('p');
  p.className = 'hint-text';
  p.textContent = text;
  return p;
}

function renderList(users) {
  els.list.innerHTML = '';
  for (const group of STATUS_GROUPS) {
    const rows = users.filter((u) => u.status === group.status);
    const section = document.createElement('section');
    section.className = `users-group users-group-${group.status}`;

    const heading = document.createElement('h3');
    heading.className = 'users-group-title';
    heading.textContent = `${group.title}（${rows.length}人）`;
    section.appendChild(heading);

    if (rows.length === 0) {
      section.appendChild(hint('該当するユーザーはいません'));
    } else {
      // 承認待ちは登録の古い順（待たせている順）、それ以外は表示名順
      const sorted =
        group.status === 'pending'
          ? rows
          : [...rows].sort((a, b) => a.display_name.localeCompare(b.display_name, 'ja'));
      for (const user of sorted) section.appendChild(createUserCard(user));
    }
    els.list.appendChild(section);
  }
}

function formatDateTime(value) {
  return value ? dateTimeFormatter.format(new Date(value)) : 'なし';
}

function createUserCard(user) {
  const card = document.createElement('article');
  card.className = 'user-card';

  const head = document.createElement('div');
  head.className = 'user-card-head';
  const name = document.createElement('span');
  name.className = 'user-card-name';
  name.textContent = user.display_name;
  head.appendChild(name);
  const kindLabel = user.is_admin ? 'グランドマスター' : user.admin_scope === 'region' ? '県連管理者' : user.admin_scope === 'branch' ? '支部管理者' : '';
  if (kindLabel) {
    const badge = document.createElement('span');
    badge.className = 'user-card-badge';
    badge.textContent = kindLabel;
    head.appendChild(badge);
  }
  card.appendChild(head);

  const meta = document.createElement('dl');
  meta.className = 'user-card-meta';
  for (const [label, value] of [
    ['支部', user.branch],
    ['メール', user.email || '（不明）'],
    ['登録日', dateFormatter.format(new Date(user.created_at))],
    ['最終ログイン', formatDateTime(user.last_login_at)],
  ]) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    meta.append(dt, dd);
  }
  card.appendChild(meta);

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

  // 管理者の種類の変更（グランドマスター・県連管理者だけ。有効なユーザーのみ）
  if (user.status === 'active' && user.can_set_scope && !user.is_admin) {
    card.appendChild(createScopeEditor(user));
  }
  return card;
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

async function runUpdate(payload) {
  try {
    await usersApi('update', 'POST', payload);
  } catch (err) {
    alert(err.message);
  }
  await loadList();
}
