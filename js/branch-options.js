import { BRANCHES } from './branches.js';
import { api } from './api.js';
import {
  setupGoogleLogin,
  loadGoogleAccount,
  showAccountGate,
  signOutLocal,
  googleLogout,
  lockHeaderName,
  roleLabelOf,
  legacyRoleOf,
  adminKindOf,
  isDataManager,
  regionBranchesOf,
} from './auth.js';

const PASSWORD_ROLES = { 123: 'user', 123123: 'admin' };
const ROLE_LABELS = { user: '一般ユーザー', admin: 'マスター管理者' };
const TYPE_LABELS = { place: '場所候補', category: 'カテゴリ候補' };

const state = {
  role: null,
  password: null,
  myName: '',
  branch: '',
  googleUser: null, // Googleでログイン中の利用者（app_usersの行）。共通パスワードのときはnull
};

const els = {
  bootLoading: document.getElementById('boot-loading'),
  loginScreen: document.getElementById('login-screen'),
  loginForm: document.getElementById('login-form'),
  passwordInput: document.getElementById('password-input'),
  loginError: document.getElementById('login-error'),
  app: document.getElementById('app'),
  roleDot: document.getElementById('role-dot'),
  roleText: document.getElementById('role-text'),
  logoutBtn: document.getElementById('logout-btn'),
  nameDisplayBtn: document.getElementById('name-display-btn'),
  nameDisplayValue: document.getElementById('name-display-value'),
  nameEditWrap: document.getElementById('name-edit-wrap'),
  nameInput: document.getElementById('name-input'),
  adminOnlyNotice: document.getElementById('admin-only-notice'),
  branchOptionsPanel: document.getElementById('branch-options-panel'),
  branchOptionsSelect: document.getElementById('branch-options-select'),
  branchOptionsContent: document.getElementById('branch-options-content'),
  placeOptionsList: document.getElementById('place-options-list'),
  categoryOptionsList: document.getElementById('category-options-list'),
};

init();

function init() {
  bindStaticEvents();
  setupGoogleLogin();
  restoreSession();
}

function bindStaticEvents() {
  els.loginForm.addEventListener('submit', handleLoginSubmit);

  els.nameDisplayBtn.addEventListener('click', () => {
    els.nameInput.value = state.myName;
    els.nameDisplayBtn.classList.add('hidden');
    els.nameEditWrap.classList.remove('hidden');
    els.nameInput.focus();
    els.nameInput.select();
  });

  els.nameInput.addEventListener('blur', saveNameEdit);
  els.nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.nameInput.blur();
    }
  });

  els.logoutBtn.addEventListener('click', handleLogout);

  for (const branch of BRANCHES) {
    const opt = document.createElement('option');
    opt.value = branch;
    opt.textContent = branch;
    els.branchOptionsSelect.appendChild(opt);
  }

  els.branchOptionsSelect.addEventListener('change', () => {
    state.branch = els.branchOptionsSelect.value;
    refreshLists();
  });
}

function saveNameEdit() {
  state.myName = els.nameInput.value.trim();
  localStorage.setItem('aichi-schedule:name', state.myName);
  updateNameDisplay();
  els.nameEditWrap.classList.add('hidden');
  els.nameDisplayBtn.classList.remove('hidden');
}

function updateNameDisplay() {
  els.nameDisplayValue.textContent = state.myName || 'お名前未設定';
}

async function restoreSession() {
  const savedName = localStorage.getItem('aichi-schedule:name') || '';
  state.myName = savedName;
  updateNameDisplay();

  const savedPassword = localStorage.getItem('aichi-schedule:password');
  const savedRole = localStorage.getItem('aichi-schedule:role');
  if (savedPassword && savedRole) {
    els.bootLoading.classList.add('hidden');
    state.password = savedPassword;
    state.role = savedRole;
    enterApp();
    return;
  }

  // 共通パスワードが無ければ、Googleでログインしているかを調べ、利用者の状態で画面を出し分ける
  let account = null;
  try {
    account = await loadGoogleAccount();
  } catch (err) {
    console.error(err);
    els.loginError.textContent = 'ログイン状態を確認できませんでした。時間をおいて再度お試しください';
  }
  els.bootLoading.classList.add('hidden');
  if (!account) {
    els.loginScreen.classList.remove('hidden');
    return;
  }
  if (account.status !== 'active') {
    showAccountGate(account);
    return;
  }
  state.googleUser = account.user;
  state.password = null;
  state.role = legacyRoleOf(account.user);
  state.myName = account.user.display_name; // 保存済みの名前(localStorage)は書き換えない
  lockHeaderName(els, account.user);
  enterApp();
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const password = els.passwordInput.value.trim();
  const role = PASSWORD_ROLES[password];
  if (!role) {
    els.loginError.textContent = 'パスワードが違います';
    return;
  }
  // 共通パスワードでログインするときは、Googleのセッションが残っていれば消す（どちらか一方だけにする）
  await signOutLocal().catch((err) => console.error(err));
  state.password = password;
  state.role = role;
  localStorage.setItem('aichi-schedule:password', password);
  localStorage.setItem('aichi-schedule:role', role);
  enterApp();
}

function handleLogout() {
  if (state.googleUser) {
    googleLogout(); // Googleのセッションを消してページを読み直す
    return;
  }
  localStorage.removeItem('aichi-schedule:password');
  localStorage.removeItem('aichi-schedule:role');
  state.password = null;
  state.role = null;

  els.app.classList.add('hidden');
  els.loginScreen.classList.remove('hidden');
  els.passwordInput.value = '';
  els.loginError.textContent = '';
}

function enterApp() {
  els.loginScreen.classList.add('hidden');
  els.app.classList.remove('hidden');
  els.roleText.textContent = state.googleUser ? roleLabelOf(state.googleUser) : ROLE_LABELS[state.role];
  els.roleDot.classList.toggle('admin', state.role === 'admin');

  // 候補管理: 共通パスワードの管理者・システム管理者（全支部）と、県連管理者（自分の県連内の支部だけ）
  if (!isDataManager(state)) {
    els.adminOnlyNotice.classList.remove('hidden');
    els.branchOptionsPanel.classList.add('hidden');
    return;
  }
  if (adminKindOf(state.googleUser) === 'region') {
    const allowed = regionBranchesOf(state.googleUser);
    for (const option of [...els.branchOptionsSelect.options]) {
      if (option.value && !allowed.includes(option.value)) option.remove();
    }
  }
  els.adminOnlyNotice.classList.add('hidden');
  els.branchOptionsPanel.classList.remove('hidden');
}

async function refreshLists() {
  if (!state.branch) {
    els.branchOptionsContent.classList.add('hidden');
    return;
  }
  els.branchOptionsContent.classList.remove('hidden');

  await Promise.all([
    renderOptionList('place', els.placeOptionsList),
    renderOptionList('category', els.categoryOptionsList),
  ]);
}

async function renderOptionList(type, listEl) {
  listEl.innerHTML = '';
  listEl.appendChild(hintEl('読み込み中…'));

  try {
    const rows = await api.getBranchOptions(state.branch, type);
    listEl.innerHTML = '';
    if (rows.length === 0) {
      listEl.appendChild(hintEl('候補はまだありません'));
      return;
    }
    for (const row of rows) {
      listEl.appendChild(createOptionRow(row, type));
    }
  } catch (err) {
    listEl.innerHTML = '';
    listEl.appendChild(hintEl(`${TYPE_LABELS[type]}の取得に失敗しました`));
  }
}

function createOptionRow(row, type) {
  const item = document.createElement('div');
  item.className = 'branch-option-row';

  const value = document.createElement('span');
  value.className = 'branch-option-value';
  value.textContent = row.value;
  item.appendChild(value);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-danger btn-small';
  deleteBtn.textContent = '削除';
  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`「${row.value}」を削除しますか？`)) return;
    deleteBtn.disabled = true;
    try {
      await api.deleteBranchOption({ id: row.id, type, password: state.password });
      await refreshLists();
    } catch (err) {
      alert(err.message);
      deleteBtn.disabled = false;
    }
  });
  item.appendChild(deleteBtn);

  return item;
}

function hintEl(text) {
  const p = document.createElement('p');
  p.className = 'hint-text';
  p.textContent = text;
  return p;
}
