import { getSupabaseClient } from './supabase-client.js';
import { api } from './api.js';

const PASSWORD_ROLES = { 123: 'user', 123123: 'admin' };
const ROLE_LABELS = { user: '一般ユーザー', admin: 'マスター管理者' };
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;
const RESIZE_QUALITIES = [0.8, 0.6, 0.4];
const BUCKET = 'equipment-images';

const state = {
  role: null,
  password: null,
  myName: '',
  items: [],
  supabase: null,
  realtimeChannel: null,
  viewMode: 'tile',
  summaryFilter: null,
  selectedImageFile: null,
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
  newItemToggleBtn: document.getElementById('new-item-toggle-btn'),
  itemForm: document.getElementById('item-form'),
  itemFormError: document.getElementById('item-form-error'),
  itemFormSubmit: document.getElementById('item-form-submit'),
  itemName: document.getElementById('item-name'),
  itemManagementNumber: document.getElementById('item-management-number'),
  itemLocation: document.getElementById('item-location'),
  itemImage: document.getElementById('item-image'),
  itemImageCameraBtn: document.getElementById('item-image-camera-btn'),
  itemImageCamera: document.getElementById('item-image-camera'),
  itemImagePreview: document.getElementById('item-image-preview'),
  itemMemo: document.getElementById('item-memo'),
  itemUpdatedBy: document.getElementById('item-updated-by'),
  viewTileBtn: document.getElementById('view-tile-btn'),
  viewSummaryBtn: document.getElementById('view-summary-btn'),
  viewInventoryBtn: document.getElementById('view-inventory-btn'),
  equipmentFilterBanner: document.getElementById('equipment-filter-banner'),
  equipmentFilterLabel: document.getElementById('equipment-filter-label'),
  equipmentFilterClear: document.getElementById('equipment-filter-clear'),
  equipmentList: document.getElementById('equipment-list'),
  equipmentSummary: document.getElementById('equipment-summary'),
  equipmentInventory: document.getElementById('equipment-inventory'),
  inventoryDatetime: document.getElementById('inventory-datetime'),
  inventoryCheckBtn: document.getElementById('inventory-check-btn'),
  equipmentInventoryResult: document.getElementById('equipment-inventory-result'),
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
    handleImageFileSelected(els.itemImage.files[0]);
    els.itemImageCamera.value = '';
  });

  els.itemImageCameraBtn.addEventListener('click', () => {
    els.itemImageCamera.click();
  });

  els.itemImageCamera.addEventListener('change', () => {
    handleImageFileSelected(els.itemImageCamera.files[0]);
    els.itemImage.value = '';
  });

  els.itemForm.addEventListener('submit', handleCreateItem);

  els.viewTileBtn.addEventListener('click', () => setViewMode('tile'));
  els.viewSummaryBtn.addEventListener('click', () => setViewMode('summary'));
  els.viewInventoryBtn.addEventListener('click', () => setViewMode('inventory'));
  els.equipmentFilterClear.addEventListener('click', () => {
    state.summaryFilter = null;
    renderEquipmentList();
  });
  els.inventoryCheckBtn.addEventListener('click', handleInventoryCheck);
}

function handleImageFileSelected(file) {
  state.selectedImageFile = file || null;
  previewImageFile(file, els.itemImagePreview);
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

  const savedPassword = localStorage.getItem('aichi-schedule:password');
  const savedRole = localStorage.getItem('aichi-schedule:role');
  els.bootLoading.classList.add('hidden');
  if (savedPassword && savedRole) {
    state.password = savedPassword;
    state.role = savedRole;
    enterApp();
  } else {
    els.loginScreen.classList.remove('hidden');
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
  localStorage.setItem('aichi-schedule:password', password);
  localStorage.setItem('aichi-schedule:role', role);
  enterApp();
}

function handleLogout() {
  if (state.realtimeChannel && state.supabase) {
    state.supabase.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
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
    renderFatalError('備品の取得に失敗しました');
    return;
  }
  state.items = data;
  applyViewMode(state.viewMode);
}

function setViewMode(mode) {
  if (mode === 'tile') {
    state.summaryFilter = null;
  }
  applyViewMode(mode);
}

function applyViewMode(mode) {
  state.viewMode = mode;
  els.viewTileBtn.classList.toggle('is-active', mode === 'tile');
  els.viewTileBtn.setAttribute('aria-selected', String(mode === 'tile'));
  els.viewSummaryBtn.classList.toggle('is-active', mode === 'summary');
  els.viewSummaryBtn.setAttribute('aria-selected', String(mode === 'summary'));
  els.viewInventoryBtn.classList.toggle('is-active', mode === 'inventory');
  els.viewInventoryBtn.setAttribute('aria-selected', String(mode === 'inventory'));
  els.equipmentList.classList.toggle('hidden', mode !== 'tile');
  els.equipmentSummary.classList.toggle('hidden', mode !== 'summary');
  els.equipmentInventory.classList.toggle('hidden', mode !== 'inventory');

  if (mode === 'tile') {
    renderEquipmentList();
  } else if (mode === 'summary') {
    renderSummaryList();
  }
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
  els.equipmentSummary.innerHTML = '';
  els.equipmentSummary.appendChild(hintEl('読み込み中…'));
}

function renderEquipmentList() {
  els.equipmentList.innerHTML = '';

  els.equipmentFilterBanner.classList.toggle('hidden', !state.summaryFilter);
  if (state.summaryFilter) {
    els.equipmentFilterLabel.textContent = `「${state.summaryFilter}」で絞り込み中`;
  }

  const items = state.summaryFilter
    ? state.items.filter((item) => item.item_name === state.summaryFilter)
    : state.items;

  if (items.length === 0) {
    els.equipmentList.appendChild(
      hintEl(state.summaryFilter ? '該当する備品はありません' : '登録されている備品はありません')
    );
    return;
  }

  for (const item of items) {
    const { tile, detail } = createEquipmentTile(item);
    els.equipmentList.appendChild(tile);
    els.equipmentList.appendChild(detail);
  }
}

// item_nameでグループ化し、合計数と保管場所別の内訳をまとめる
function renderSummaryList() {
  els.equipmentSummary.innerHTML = '';

  if (state.items.length === 0) {
    els.equipmentSummary.appendChild(hintEl('登録されている備品はありません'));
    return;
  }

  const groups = new Map();
  for (const item of state.items) {
    if (!groups.has(item.item_name)) {
      groups.set(item.item_name, { count: 0, locations: new Map() });
    }
    const group = groups.get(item.item_name);
    group.count += 1;
    group.locations.set(item.location, (group.locations.get(item.location) || 0) + 1);
  }

  for (const [itemName, group] of groups) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'equipment-summary-row';

    const name = document.createElement('span');
    name.className = 'equipment-summary-name';
    name.textContent = itemName;
    row.appendChild(name);

    const count = document.createElement('span');
    count.className = 'equipment-summary-count';
    count.textContent = `合計 ${group.count}個`;
    row.appendChild(count);

    const breakdown = document.createElement('span');
    breakdown.className = 'equipment-summary-breakdown';
    breakdown.textContent = [...group.locations.entries()]
      .map(([location, locationCount]) => `${location}: ${locationCount}個`)
      .join(' / ');
    row.appendChild(breakdown);

    row.addEventListener('click', () => {
      state.summaryFilter = itemName;
      applyViewMode('tile');
    });

    els.equipmentSummary.appendChild(row);
  }
}

// 指定日時以前でequipment_idごとに一番新しいequipment_historyレコードを取得し、
// その時点で各備品がどこにあったかを種類別に集計する
async function handleInventoryCheck() {
  const value = els.inventoryDatetime.value;
  els.equipmentInventoryResult.innerHTML = '';

  if (!value) {
    els.equipmentInventoryResult.appendChild(hintEl('日時を選択してください'));
    return;
  }

  const cutoffIso = new Date(value).toISOString();
  els.inventoryCheckBtn.disabled = true;
  els.equipmentInventoryResult.appendChild(hintEl('確認中…'));

  try {
    const { data, error } = await state.supabase
      .from('equipment_history')
      .select('equipment_id, location, moved_at')
      .lte('moved_at', cutoffIso)
      .order('moved_at', { ascending: false });
    if (error) {
      throw new Error(error.message);
    }

    // moved_at降順で取得しているので、equipment_idごとに最初に出てきたものが
    // 「指定日時以前で最新」のレコードになる
    const latestLocationByEquipment = new Map();
    for (const row of data) {
      if (!latestLocationByEquipment.has(row.equipment_id)) {
        latestLocationByEquipment.set(row.equipment_id, row.location);
      }
    }

    const itemsById = new Map(state.items.map((item) => [item.id, item]));
    const groups = new Map();
    for (const [equipmentId, location] of latestLocationByEquipment) {
      const item = itemsById.get(equipmentId);
      if (!item) continue; // 削除済みの備品は対象外

      if (!groups.has(item.item_name)) {
        groups.set(item.item_name, { count: 0, locations: new Map() });
      }
      const group = groups.get(item.item_name);
      group.count += 1;
      group.locations.set(location, (group.locations.get(location) || 0) + 1);
    }

    renderInventoryResult(groups);
  } catch (err) {
    els.equipmentInventoryResult.innerHTML = '';
    els.equipmentInventoryResult.appendChild(hintEl(`取得に失敗しました: ${err.message}`));
  } finally {
    els.inventoryCheckBtn.disabled = false;
  }
}

function renderInventoryResult(groups) {
  els.equipmentInventoryResult.innerHTML = '';

  if (groups.size === 0) {
    els.equipmentInventoryResult.appendChild(hintEl('この時点のデータはありません'));
    return;
  }

  const sortedNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  for (const itemName of sortedNames) {
    const group = groups.get(itemName);

    const row = document.createElement('div');
    row.className = 'equipment-summary-row is-static';

    const name = document.createElement('span');
    name.className = 'equipment-summary-name';
    name.textContent = itemName;
    row.appendChild(name);

    const count = document.createElement('span');
    count.className = 'equipment-summary-count';
    count.textContent = `合計 ${group.count}個`;
    row.appendChild(count);

    const breakdown = document.createElement('span');
    breakdown.className = 'equipment-summary-breakdown';
    breakdown.textContent = [...group.locations.entries()]
      .map(([location, locationCount]) => `${location}: ${locationCount}個`)
      .join(' / ');
    row.appendChild(breakdown);

    els.equipmentInventoryResult.appendChild(row);
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
    const img = document.createElement('img');
    img.className = 'equipment-tile-image';
    img.src = item.image_url;
    img.alt = item.item_name;
    img.loading = 'lazy';
    tile.appendChild(img);
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

  if (item.management_number) {
    const number = document.createElement('span');
    number.className = 'equipment-tile-number';
    number.textContent = `No. ${item.management_number}`;
    tile.appendChild(number);
  }

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

  if (item.management_number) {
    const number = document.createElement('p');
    number.className = 'equipment-management-number';
    number.textContent = `No. ${item.management_number}`;
    detail.appendChild(number);
  }

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

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = item.item_name;
  nameInput.placeholder = '品目名';

  const managementNumberInput = document.createElement('input');
  managementNumberInput.type = 'text';
  managementNumberInput.value = item.management_number || '';
  managementNumberInput.placeholder = '管理番号（任意）';

  const locationInput = document.createElement('input');
  locationInput.type = 'text';
  locationInput.value = item.location;
  locationInput.placeholder = '保管場所';

  let editSelectedImageFile = null;

  const imagePreview = document.createElement('img');
  imagePreview.className = 'image-preview';
  if (item.image_url) {
    imagePreview.src = item.image_url;
    imagePreview.classList.add('visible');
  }

  const imageFileInput = document.createElement('input');
  imageFileInput.type = 'file';
  imageFileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';

  const imageCameraInput = document.createElement('input');
  imageCameraInput.type = 'file';
  imageCameraInput.accept = 'image/*';
  imageCameraInput.capture = 'environment';
  imageCameraInput.classList.add('hidden');

  const imageCameraBtn = document.createElement('button');
  imageCameraBtn.type = 'button';
  imageCameraBtn.className = 'btn btn-outline btn-small';
  imageCameraBtn.textContent = '📷 写真を撮る';
  imageCameraBtn.addEventListener('click', () => imageCameraInput.click());

  const handleEditImageSelected = (file) => {
    editSelectedImageFile = file || null;
    previewImageFile(file, imagePreview);
  };

  imageFileInput.addEventListener('change', () => {
    handleEditImageSelected(imageFileInput.files[0]);
    imageCameraInput.value = '';
  });
  imageCameraInput.addEventListener('change', () => {
    handleEditImageSelected(imageCameraInput.files[0]);
    imageFileInput.value = '';
  });

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
    const itemName = nameInput.value.trim();
    if (!itemName) {
      errorText.textContent = '品目名を入力してください';
      return;
    }
    if (!updatedBy) {
      errorText.textContent = '更新者名を入力してください';
      return;
    }
    saveBtn.disabled = true;
    try {
      const payload = {
        item_name: itemName,
        management_number: managementNumberInput.value.trim(),
        location: locationInput.value.trim(),
        memo: memoInput.value.trim(),
        updated_by: updatedBy,
        password: state.password,
      };

      if (editSelectedImageFile) {
        saveBtn.textContent = '画像を処理中…';
        const resized = await resizeImage(editSelectedImageFile);
        saveBtn.textContent = 'アップロード中…';
        payload.image_url = await uploadImage(resized);
        saveBtn.textContent = '保存';
      }

      await api.updateEquipment(item.id, payload);
      await fetchItems();
    } catch (err) {
      errorText.textContent = err.message;
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
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

  detail.appendChild(nameInput);
  detail.appendChild(managementNumberInput);
  detail.appendChild(locationInput);
  detail.appendChild(imagePreview);
  detail.appendChild(imageFileInput);
  detail.appendChild(imageCameraBtn);
  detail.appendChild(imageCameraInput);
  detail.appendChild(memoInput);
  detail.appendChild(updatedByInput);
  detail.appendChild(errorText);
  detail.appendChild(actions);
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像の読み込みに失敗しました'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function toJpgFileName(name) {
  const base = name.replace(/\.[^./]+$/, '') || 'image';
  return `${base}.jpg`;
}

// アップロード前に長辺1600px以下・JPEG品質0.8〜0.4に段階的に再圧縮する
async function resizeImage(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('対応していない画像形式です（PNG/JPEG/WebP/GIFのみ）');
  }

  const img = await loadImageElement(file);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

  for (const quality of RESIZE_QUALITIES) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (blob && blob.size <= MAX_IMAGE_BYTES) {
      return new File([blob], toJpgFileName(file.name), { type: 'image/jpeg' });
    }
  }
  throw new Error('画像を圧縮しても5MBを超えています。別の画像を選んでください');
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

  const submitLabel = els.itemFormSubmit.textContent;
  els.itemFormSubmit.disabled = true;
  try {
    let imageUrl = '';
    const file = state.selectedImageFile;
    if (file) {
      els.itemFormSubmit.textContent = '画像を処理中…';
      const resized = await resizeImage(file);
      els.itemFormSubmit.textContent = 'アップロード中…';
      imageUrl = await uploadImage(resized);
      els.itemFormSubmit.textContent = submitLabel;
    }

    await api.createEquipment({
      item_name: els.itemName.value.trim(),
      management_number: els.itemManagementNumber.value.trim(),
      location: els.itemLocation.value.trim(),
      image_url: imageUrl,
      memo: els.itemMemo.value.trim(),
      updated_by: updatedBy,
      password: state.password,
    });

    els.itemForm.reset();
    state.selectedImageFile = null;
    els.itemImagePreview.classList.remove('visible');
    els.itemForm.classList.add('hidden');
    els.newItemToggleBtn.textContent = '＋ 備品を登録';
    await fetchItems();
  } catch (err) {
    els.itemFormError.textContent = err.message;
  } finally {
    els.itemFormSubmit.disabled = false;
    els.itemFormSubmit.textContent = submitLabel;
  }
}

function renderFatalError(message) {
  els.equipmentList.innerHTML = '';
  els.equipmentList.appendChild(hintEl(message));
  els.equipmentSummary.innerHTML = '';
  els.equipmentSummary.appendChild(hintEl(message));
}
