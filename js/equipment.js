import { getSupabaseClient } from './supabase-client.js';
import { api } from './api.js';

const PASSWORD_ROLES = { 123: 'user', 123123: 'admin' };
const ROLE_LABELS = { user: '一般ユーザー', admin: 'マスター管理者' };
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BUCKET = 'equipment-images';

const state = {
  role: null,
  password: null,
  myName: '',
  items: [],
  supabase: null,
  realtimeChannel: null,
};

const els = {
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
  newItemToggleBtn: document.getElementById('new-item-toggle-btn'),
  itemForm: document.getElementById('item-form'),
  itemFormError: document.getElementById('item-form-error'),
  itemFormSubmit: document.getElementById('item-form-submit'),
  itemName: document.getElementById('item-name'),
  itemLocation: document.getElementById('item-location'),
  itemImage: document.getElementById('item-image'),
  itemImagePreview: document.getElementById('item-image-preview'),
  itemMemo: document.getElementById('item-memo'),
  itemUpdatedBy: document.getElementById('item-updated-by'),
  equipmentList: document.getElementById('equipment-list'),
};

init();

function init() {
  bindStaticEvents();
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

  els.newItemToggleBtn.addEventListener('click', () => {
    const isHidden = els.itemForm.classList.toggle('hidden');
    els.newItemToggleBtn.textContent = isHidden ? '＋ 備品を登録' : '閉じる';
    if (!isHidden) {
      els.itemUpdatedBy.value = state.myName;
      els.itemFormError.textContent = '';
    }
  });

  els.itemImage.addEventListener('change', () => {
    previewImageFile(els.itemImage.files[0], els.itemImagePreview);
  });

  els.itemForm.addEventListener('submit', handleCreateItem);
}

function previewImageFile(file, imgEl) {
  if (!file) {
    imgEl.classList.remove('visible');
    imgEl.removeAttribute('src');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    imgEl.src = reader.result;
    imgEl.classList.add('visible');
  };
  reader.readAsDataURL(file);
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

function restoreSession() {
  const savedName = localStorage.getItem('aichi-schedule:name') || '';
  state.myName = savedName;
  updateNameDisplay();

  const savedPassword = sessionStorage.getItem('aichi-schedule:password');
  const savedRole = sessionStorage.getItem('aichi-schedule:role');
  if (savedPassword && savedRole) {
    state.password = savedPassword;
    state.role = savedRole;
    enterApp();
  }
}

function handleLoginSubmit(event) {
  event.preventDefault();
  const password = els.passwordInput.value.trim();
  const role = PASSWORD_ROLES[password];
  if (!role) {
    els.loginError.textContent = 'パスワードが違います';
    return;
  }
  state.password = password;
  state.role = role;
  sessionStorage.setItem('aichi-schedule:password', password);
  sessionStorage.setItem('aichi-schedule:role', role);
  enterApp();
}

function handleLogout() {
  if (state.realtimeChannel && state.supabase) {
    state.supabase.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  sessionStorage.removeItem('aichi-schedule:password');
  sessionStorage.removeItem('aichi-schedule:role');
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
  els.roleText.textContent = ROLE_LABELS[state.role];
  els.roleDot.classList.toggle('admin', state.role === 'admin');
  els.newItemToggleBtn.classList.toggle('hidden', state.role !== 'admin');
  boot();
}

async function boot() {
  try {
    state.supabase = await getSupabaseClient();
  } catch (err) {
    renderFatalError(err.message);
    return;
  }
  await fetchItems();
  subscribeRealtime();
}

async function fetchItems() {
  renderLoadingState();

  const { data, error } = await state.supabase
    .from('equipment')
    .select('*')
    .order('item_name', { ascending: true });

  if (error) {
    console.error(error);
    state.items = [];
    renderEquipmentList('備品の取得に失敗しました');
    return;
  }
  state.items = data;
  renderEquipmentList();
}

function subscribeRealtime() {
  if (state.realtimeChannel) {
    state.supabase.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  state.realtimeChannel = state.supabase
    .channel('equipment-list')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'equipment' }, () => {
      fetchItems();
    })
    .subscribe();
}

function renderLoadingState() {
  els.equipmentList.innerHTML = '';
  els.equipmentList.appendChild(hintEl('読み込み中…'));
}

function renderEquipmentList(errorMessage) {
  els.equipmentList.innerHTML = '';

  if (errorMessage) {
    els.equipmentList.appendChild(hintEl(errorMessage));
    return;
  }
  if (state.items.length === 0) {
    els.equipmentList.appendChild(hintEl('登録されている備品はありません'));
    return;
  }

  for (const item of state.items) {
    const { tile, detail } = createEquipmentTile(item);
    els.equipmentList.appendChild(tile);
    els.equipmentList.appendChild(detail);
  }
}

function hintEl(text) {
  const p = document.createElement('p');
  p.className = 'hint-text';
  p.textContent = text;
  return p;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 正方形タイル＋タップで直下に展開する詳細パネルの組を作る
function createEquipmentTile(item) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'equipment-tile';

  if (item.image_url) {
    tile.classList.add('has-image');
    tile.style.backgroundImage = `url("${item.image_url}")`;
  } else {
    const icon = document.createElement('span');
    icon.className = 'equipment-tile-icon';
    icon.textContent = '📦';
    tile.appendChild(icon);
  }

  const name = document.createElement('span');
  name.className = 'equipment-tile-name';
  name.textContent = item.item_name;
  tile.appendChild(name);

  const detail = document.createElement('div');
  detail.className = 'equipment-detail hidden';
  renderDetailBody(item, detail);

  tile.addEventListener('click', () => {
    const isHidden = detail.classList.toggle('hidden');
    tile.classList.toggle('is-open', !isHidden);
  });

  return { tile, detail };
}

function renderDetailBody(item, detail) {
  detail.innerHTML = '';
  detail.classList.remove('equipment-card-editing');

  const location = document.createElement('p');
  location.className = 'equipment-location';
  location.textContent = `保管場所: ${item.location}`;
  detail.appendChild(location);

  if (item.memo) {
    const memo = document.createElement('p');
    memo.className = 'equipment-memo';
    memo.textContent = item.memo;
    detail.appendChild(memo);
  }

  const updated = document.createElement('p');
  updated.className = 'equipment-updated';
  updated.textContent = `最終更新: ${item.updated_by} ・ ${formatDateTime(item.updated_at)}`;
  detail.appendChild(updated);

  const historyPanel = document.createElement('div');
  historyPanel.className = 'history-panel hidden';

  detail.appendChild(createActionsRow(item, detail, historyPanel));
  detail.appendChild(historyPanel);
}

function createActionsRow(item, detail, historyPanel) {
  const row = document.createElement('div');
  row.className = 'event-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn-outline btn-small';
  editBtn.textContent = '編集';
  editBtn.addEventListener('click', () => enterEditMode(item, detail));

  const historyBtn = document.createElement('button');
  historyBtn.type = 'button';
  historyBtn.className = 'btn btn-outline btn-small';
  historyBtn.textContent = '履歴';
  historyBtn.addEventListener('click', () => {
    const isHidden = historyPanel.classList.toggle('hidden');
    if (!isHidden) {
      loadHistory(item, historyPanel);
    }
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-danger btn-small';
  deleteBtn.textContent = '削除';
  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`「${item.item_name}」を削除しますか？`)) return;
    try {
      await api.deleteEquipment(item.id, { password: state.password });
      await fetchItems();
    } catch (err) {
      alert(err.message);
    }
  });
  if (state.role !== 'admin') {
    deleteBtn.disabled = true;
    deleteBtn.title = '削除はマスター管理者のみ可能です';
  }

  row.appendChild(editBtn);
  row.appendChild(historyBtn);
  row.appendChild(deleteBtn);
  return row;
}

async function loadHistory(item, panel) {
  panel.innerHTML = '';
  panel.appendChild(hintEl('読み込み中…'));

  const { data, error } = await state.supabase
    .from('equipment_history')
    .select('*')
    .eq('equipment_id', item.id)
    .order('moved_at', { ascending: false });

  panel.innerHTML = '';
  if (error) {
    panel.appendChild(hintEl('履歴の取得に失敗しました'));
    return;
  }
  if (data.length === 0) {
    panel.appendChild(hintEl('履歴がありません'));
    return;
  }

  const list = document.createElement('ul');
  list.className = 'history-list';
  for (const entry of data) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const location = document.createElement('span');
    location.className = 'history-location';
    location.textContent = entry.location;

    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = `${entry.moved_by} ・ ${formatDateTime(entry.moved_at)}`;

    li.appendChild(location);
    li.appendChild(meta);
    list.appendChild(li);
  }
  panel.appendChild(list);
}

function enterEditMode(item, detail) {
  detail.innerHTML = '';
  detail.classList.add('equipment-card-editing');

  const nameLabel = document.createElement('p');
  nameLabel.className = 'equipment-name';
  nameLabel.textContent = item.item_name;

  const locationInput = document.createElement('input');
  locationInput.type = 'text';
  locationInput.value = item.location;
  locationInput.placeholder = '保管場所';

  const memoInput = document.createElement('textarea');
  memoInput.value = item.memo || '';
  memoInput.placeholder = 'メモ';

  const updatedByInput = document.createElement('input');
  updatedByInput.type = 'text';
  updatedByInput.value = state.myName;
  updatedByInput.placeholder = 'お名前';

  const errorText = document.createElement('p');
  errorText.className = 'form-error';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-small';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', async () => {
    const updatedBy = updatedByInput.value.trim();
    if (!updatedBy) {
      errorText.textContent = '更新者名を入力してください';
      return;
    }
    saveBtn.disabled = true;
    try {
      await api.updateEquipment(item.id, {
        location: locationInput.value.trim(),
        memo: memoInput.value.trim(),
        updated_by: updatedBy,
        password: state.password,
      });
      await fetchItems();
    } catch (err) {
      errorText.textContent = err.message;
      saveBtn.disabled = false;
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-outline btn-small';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.addEventListener('click', () => renderDetailBody(item, detail));

  const actions = document.createElement('div');
  actions.className = 'event-actions';
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  detail.appendChild(nameLabel);
  detail.appendChild(locationInput);
  detail.appendChild(memoInput);
  detail.appendChild(updatedByInput);
  detail.appendChild(errorText);
  detail.appendChild(actions);
}

async function uploadImage(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('対応していない画像形式です（PNG/JPEG/WebP/GIFのみ）');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('画像サイズは5MB以内にしてください');
  }

  const { path, token, publicUrl } = await api.getEquipmentUploadUrl({
    contentType: file.type,
    password: state.password,
  });

  const { error } = await state.supabase.storage
    .from(BUCKET)
    .uploadToSignedUrl(path, token, file, { contentType: file.type });
  if (error) {
    throw new Error(error.message);
  }
  return publicUrl;
}

async function handleCreateItem(event) {
  event.preventDefault();
  els.itemFormError.textContent = '';

  const updatedBy = els.itemUpdatedBy.value.trim();
  if (!updatedBy) {
    els.itemFormError.textContent = '更新者名を入力してください';
    return;
  }

  els.itemFormSubmit.disabled = true;
  try {
    let imageUrl = '';
    const file = els.itemImage.files[0];
    if (file) {
      imageUrl = await uploadImage(file);
    }

    await api.createEquipment({
      item_name: els.itemName.value.trim(),
      location: els.itemLocation.value.trim(),
      image_url: imageUrl,
      memo: els.itemMemo.value.trim(),
      updated_by: updatedBy,
      password: state.password,
    });

    els.itemForm.reset();
    els.itemImagePreview.classList.remove('visible');
    els.itemForm.classList.add('hidden');
    els.newItemToggleBtn.textContent = '＋ 備品を登録';
    await fetchItems();
  } catch (err) {
    els.itemFormError.textContent = err.message;
  } finally {
    els.itemFormSubmit.disabled = false;
  }
}

function renderFatalError(message) {
  els.equipmentList.innerHTML = '';
  els.equipmentList.appendChild(hintEl(message));
}
