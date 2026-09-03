import { getSupabaseClient } from './supabase-client.js';
import { api } from './api.js';
import { OWNER_BRANCH_OPTIONS, SHARED_OWNER_BRANCHES } from './owner-branches.js';

const PASSWORD_ROLES = { 123: 'user', 123123: 'admin' };
const ROLE_LABELS = { user: '一般ユーザー', admin: 'マスター管理者' };
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;
const RESIZE_QUALITIES = [0.8, 0.6, 0.4];
const BUCKET = 'equipment-images';
// 数量その場変更が自分自身のRealtime echoを消化しそこねた場合の保険（この時間内に届かなければ諦める）
const REALTIME_ECHO_TIMEOUT_MS = 5000;

const state = {
  role: null,
  password: null,
  myName: '',
  items: [],
  supabase: null,
  realtimeChannel: null,
  viewMode: 'tile',
  summaryFilter: null,
  ownerFilter: '',
  sharedFilter: '',
  countableFilter: '',
  summaryCountableFilter: '',
  inventoryCountableFilter: '',
  selectedImageFile: null,
  pendingLocalQuantityUpdates: 0,
  pendingRealtimeTimeouts: [],
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
  itemQuantity: document.getElementById('item-quantity'),
  itemIsCountable: document.getElementById('item-is-countable'),
  itemLocation: document.getElementById('item-location'),
  itemOwnerBranch: document.getElementById('item-owner-branch'),
  itemOwnerPerson: document.getElementById('item-owner-person'),
  itemIsShared: document.getElementById('item-is-shared'),
  itemImage: document.getElementById('item-image'),
  itemImageCameraBtn: document.getElementById('item-image-camera-btn'),
  itemImageCamera: document.getElementById('item-image-camera'),
  itemImagePreview: document.getElementById('item-image-preview'),
  itemMemo: document.getElementById('item-memo'),
  itemUpdatedBy: document.getElementById('item-updated-by'),
  viewTileBtn: document.getElementById('view-tile-btn'),
  viewSummaryBtn: document.getElementById('view-summary-btn'),
  viewInventoryBtn: document.getElementById('view-inventory-btn'),
  equipmentOwnerFilterWrap: document.getElementById('equipment-owner-filter-wrap'),
  equipmentOwnerFilter: document.getElementById('equipment-owner-filter'),
  equipmentSharedFilterWrap: document.getElementById('equipment-shared-filter-wrap'),
  equipmentSharedFilter: document.getElementById('equipment-shared-filter'),
  equipmentCountableFilterWrap: document.getElementById('equipment-countable-filter-wrap'),
  equipmentCountableFilter: document.getElementById('equipment-countable-filter'),
  equipmentSummaryCountableFilterWrap: document.getElementById('equipment-summary-countable-filter-wrap'),
  equipmentSummaryCountableFilter: document.getElementById('equipment-summary-countable-filter'),
  equipmentInventoryCountableFilter: document.getElementById('equipment-inventory-countable-filter'),
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
  populateOwnerBranchSelect(els.itemOwnerBranch, { includeBlank: true, blankLabel: '未定' });
  populateOwnerBranchSelect(els.equipmentOwnerFilter, { includeBlank: true, blankLabel: 'すべて' });
  bindStaticEvents();
  restoreSession();
}

// 所有プルダウン共通: 先頭に空選択肢、続けて西県連→東県連→1〜16支部→その他の固定19択
function populateOwnerBranchSelect(selectEl, { includeBlank, blankLabel } = {}) {
  selectEl.innerHTML = '';
  if (includeBlank) {
    const blankOption = document.createElement('option');
    blankOption.value = '';
    blankOption.textContent = blankLabel || '';
    selectEl.appendChild(blankOption);
  }
  for (const branch of OWNER_BRANCH_OPTIONS) {
    const option = document.createElement('option');
    option.value = branch;
    option.textContent = branch;
    selectEl.appendChild(option);
  }
}

// 所有が西県連/東県連の間は「全体で使用」を常時チェック・操作不可にする
function syncIsSharedCheckbox(ownerBranchSelectEl, isSharedCheckboxEl) {
  const forced = SHARED_OWNER_BRANCHES.includes(ownerBranchSelectEl.value);
  isSharedCheckboxEl.disabled = forced;
  if (forced) {
    isSharedCheckboxEl.checked = true;
  }
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

  els.itemOwnerBranch.addEventListener('change', () => {
    syncIsSharedCheckbox(els.itemOwnerBranch, els.itemIsShared);
  });

  els.itemForm.addEventListener('submit', handleCreateItem);

  els.viewTileBtn.addEventListener('click', () => setViewMode('tile'));
  els.viewSummaryBtn.addEventListener('click', () => setViewMode('summary'));
  els.viewInventoryBtn.addEventListener('click', () => setViewMode('inventory'));
  els.equipmentFilterClear.addEventListener('click', () => {
    state.summaryFilter = null;
    renderEquipmentList();
  });
  els.equipmentOwnerFilter.addEventListener('change', () => {
    state.ownerFilter = els.equipmentOwnerFilter.value;
    renderEquipmentList();
  });
  els.equipmentSharedFilter.addEventListener('change', () => {
    state.sharedFilter = els.equipmentSharedFilter.value;
    renderEquipmentList();
  });
  els.equipmentCountableFilter.addEventListener('change', () => {
    state.countableFilter = els.equipmentCountableFilter.value;
    renderEquipmentList();
  });
  els.equipmentSummaryCountableFilter.addEventListener('change', () => {
    state.summaryCountableFilter = els.equipmentSummaryCountableFilter.value;
    renderSummaryList();
  });
  els.equipmentInventoryCountableFilter.addEventListener('change', () => {
    state.inventoryCountableFilter = els.equipmentInventoryCountableFilter.value;
    if (els.inventoryDatetime.value) {
      handleInventoryCheck();
    }
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
  els.equipmentOwnerFilterWrap.classList.toggle('hidden', mode !== 'tile');
  els.equipmentSharedFilterWrap.classList.toggle('hidden', mode !== 'tile');
  els.equipmentCountableFilterWrap.classList.toggle('hidden', mode !== 'tile');
  els.equipmentSummaryCountableFilterWrap.classList.toggle('hidden', mode !== 'summary');

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
      // 数量その場変更が発生させた自分自身のechoは消化するだけでfetchItems()は呼ばない
      // （呼ぶと一覧が作り直され、開いている詳細パネルが閉じてしまうため）
      if (state.pendingLocalQuantityUpdates > 0) {
        state.pendingLocalQuantityUpdates -= 1;
        const timeoutId = state.pendingRealtimeTimeouts.shift();
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        return;
      }
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

  const items = state.items
    .filter((item) => !state.summaryFilter || item.item_name === state.summaryFilter)
    .filter((item) => !state.ownerFilter || item.owner_branch === state.ownerFilter)
    .filter((item) => {
      if (state.sharedFilter === 'shared') return item.is_shared;
      if (state.sharedFilter === 'branch') return !item.is_shared;
      return true;
    })
    .filter((item) => state.countableFilter !== 'countable' || item.is_countable);

  if (items.length === 0) {
    els.equipmentList.appendChild(
      hintEl(
        state.summaryFilter || state.ownerFilter || state.sharedFilter || state.countableFilter
          ? '該当する備品はありません'
          : '登録されている備品はありません'
      )
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

  const items = state.items.filter(
    (item) => state.summaryCountableFilter !== 'countable' || item.is_countable
  );

  if (items.length === 0) {
    els.equipmentSummary.appendChild(
      hintEl(state.summaryCountableFilter ? '該当する備品はありません' : '登録されている備品はありません')
    );
    return;
  }

  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.item_name)) {
      groups.set(item.item_name, { count: 0, locations: new Map(), owners: new Map(), items: [] });
    }
    const group = groups.get(item.item_name);
    group.count += 1;
    group.locations.set(item.location, (group.locations.get(item.location) || 0) + 1);
    const ownerLabel = item.owner_branch || '未定';
    group.owners.set(ownerLabel, (group.owners.get(ownerLabel) || 0) + 1);
    group.items.push(item);
  }

  for (const [itemName, group] of groups) {
    const row = document.createElement('div');
    row.className = 'equipment-summary-row';

    const name = document.createElement('span');
    name.className = 'equipment-summary-name';
    name.textContent = itemName;
    row.appendChild(name);

    const count = document.createElement('span');
    count.className = 'equipment-summary-count';
    count.textContent = `合計 ${group.count}個`;
    row.appendChild(count);

    const locationBreakdown = document.createElement('span');
    locationBreakdown.className = 'equipment-summary-breakdown';
    locationBreakdown.textContent = `場所内訳: ${[...group.locations.entries()]
      .map(([location, locationCount]) => `${location}: ${locationCount}個`)
      .join(' / ')}`;
    row.appendChild(locationBreakdown);

    const ownerBreakdown = document.createElement('span');
    ownerBreakdown.className = 'equipment-summary-breakdown';
    ownerBreakdown.textContent = `所有内訳: ${[...group.owners.entries()]
      .map(([owner, ownerCount]) => `${owner}: ${ownerCount}個`)
      .join(' / ')}`;
    row.appendChild(ownerBreakdown);

    const viewInListBtn = document.createElement('button');
    viewInListBtn.type = 'button';
    viewInListBtn.className = 'btn btn-outline btn-small equipment-summary-row-action';
    viewInListBtn.textContent = '一覧で見る';
    viewInListBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      state.summaryFilter = itemName;
      applyViewMode('tile');
    });
    row.appendChild(viewInListBtn);

    const detailGroup = document.createElement('div');
    detailGroup.className = 'equipment-summary-detail-group hidden';
    for (const groupItem of group.items) {
      detailGroup.appendChild(createDetailPanel(groupItem, { hidden: false }));
    }

    setupExpandableRow(row, detailGroup);

    els.equipmentSummary.appendChild(row);
    els.equipmentSummary.appendChild(detailGroup);
  }
}

// 行クリック/Enter/Spaceでdetailグループの開閉をトグルする共通処理（種類別・在庫確認で共用）
function setupExpandableRow(row, detailGroup) {
  row.setAttribute('role', 'button');
  row.tabIndex = 0;

  row.addEventListener('click', () => {
    const isHidden = detailGroup.classList.toggle('hidden');
    row.classList.toggle('is-open', !isHidden);
  });

  row.addEventListener('keydown', (event) => {
    // 「一覧で見る」等、行内の子要素にフォーカスがある時のkeydownバブリングでは反応しない
    if (event.target !== row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      row.click();
    }
  });
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
      if (state.inventoryCountableFilter === 'countable' && !item.is_countable) continue;

      if (!groups.has(item.item_name)) {
        groups.set(item.item_name, { count: 0, locations: new Map(), items: [] });
      }
      const group = groups.get(item.item_name);
      group.count += 1;
      group.locations.set(location, (group.locations.get(location) || 0) + 1);
      group.items.push(item);
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

    const detailGroup = document.createElement('div');
    detailGroup.className = 'equipment-summary-detail-group hidden';
    for (const groupItem of group.items) {
      detailGroup.appendChild(createDetailPanel(groupItem, { hidden: false }));
    }

    setupExpandableRow(row, detailGroup);

    els.equipmentInventoryResult.appendChild(row);
    els.equipmentInventoryResult.appendChild(detailGroup);
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

  if (item.quantity >= 2) {
    const quantity = document.createElement('span');
    quantity.className = 'equipment-tile-quantity';
    quantity.textContent = `×${item.quantity}`;
    tile.appendChild(quantity);
  }

  if (item.owner_branch) {
    const owner = document.createElement('span');
    owner.className = 'equipment-tile-owner';
    owner.textContent = item.owner_branch;
    tile.appendChild(owner);
  }

  if (item.is_shared || item.is_countable) {
    const badges = document.createElement('div');
    badges.className = 'equipment-tile-badges';
    if (item.is_shared) {
      const sharedBadge = document.createElement('span');
      sharedBadge.className = 'equipment-tile-badge';
      sharedBadge.textContent = '全体使用';
      badges.appendChild(sharedBadge);
    }
    if (item.is_countable) {
      const countableBadge = document.createElement('span');
      countableBadge.className = 'equipment-tile-badge';
      countableBadge.textContent = '変動';
      badges.appendChild(countableBadge);
    }
    tile.appendChild(badges);
  }

  const detail = createDetailPanel(item);

  tile.addEventListener('click', () => {
    const isHidden = detail.classList.toggle('hidden');
    tile.classList.toggle('is-open', !isHidden);
  });

  return { tile, detail };
}

// detail要素を作ってrenderDetailBodyで中身を組み立てる。
// 一覧タイル・種類別・在庫確認のどのビューからも同じ詳細パネルを使い回すための共通処理。
// hidden:true(既定)は要素自身の開閉をタイル側で直接トグルする一覧タイル向け。
// hidden:falseは種類別・在庫確認向け（複数件を並べて外側のdetailGroup側だけで開閉を制御するため、
// 個々のdetail自身は最初から表示状態にしておく必要がある）
function createDetailPanel(item, { hidden = true } = {}) {
  const detail = document.createElement('div');
  detail.className = hidden ? 'equipment-detail hidden' : 'equipment-detail';
  renderDetailBody(item, detail);
  return detail;
}

function renderDetailBody(item, detail) {
  detail.innerHTML = '';
  detail.classList.remove('equipment-card-editing');

  if (item.image_url) {
    const img = document.createElement('img');
    img.className = 'equipment-detail-image';
    img.src = item.image_url;
    img.alt = item.item_name;
    img.loading = 'lazy';
    detail.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'equipment-detail-icon';
    icon.textContent = '📦';
    detail.appendChild(icon);
  }

  if (item.management_number) {
    const number = document.createElement('p');
    number.className = 'equipment-management-number';
    number.textContent = `No. ${item.management_number}`;
    detail.appendChild(number);
  }

  const quantity = document.createElement('p');
  quantity.className = 'equipment-quantity';
  quantity.textContent = item.is_countable ? `数量: ${item.quantity} ・ 数量変動あり` : `数量: ${item.quantity}`;
  detail.appendChild(quantity);

  if (item.is_countable) {
    detail.appendChild(createQuantityAdjuster(item, detail));
  }

  const location = document.createElement('p');
  location.className = 'equipment-location';
  location.textContent = `保管場所: ${item.location}`;
  detail.appendChild(location);

  const owner = document.createElement('p');
  owner.className = 'equipment-owner';
  owner.textContent = `所有：${item.owner_branch || '未定'}（担当：${item.owner_person || '×'}）`;
  detail.appendChild(owner);

  if (item.is_shared) {
    const badge = document.createElement('span');
    badge.className = 'equipment-shared-badge';
    badge.textContent = '全体使用';
    detail.appendChild(badge);
  }

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

// タイル内の「×N」数量表示を差し替える。1以下では非表示、2以上で表示（要素がなければ作る）
function updateTileQuantityDisplay(tile, quantity) {
  let quantityEl = tile.querySelector('.equipment-tile-quantity');
  if (quantity >= 2) {
    if (!quantityEl) {
      quantityEl = document.createElement('span');
      quantityEl.className = 'equipment-tile-quantity';
      // 生成順（品目名→管理番号→数量→所有→バッジ）に合わせ、
      // 管理番号（無ければ品目名）の直後に挿入する
      const precedingEl = tile.querySelector('.equipment-tile-number') || tile.querySelector('.equipment-tile-name');
      tile.insertBefore(quantityEl, precedingEl ? precedingEl.nextSibling : tile.firstChild);
    }
    quantityEl.textContent = `×${quantity}`;
  } else if (quantityEl) {
    quantityEl.remove();
  }
}

// is_countableな備品の詳細パネルに出す、その場で数量を変更するUI（編集モードには入らない）
function createQuantityAdjuster(item, detail) {
  const wrap = document.createElement('div');
  wrap.className = 'equipment-quantity-adjuster';

  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.className = 'btn btn-outline btn-small';
  minusBtn.textContent = '−';

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'btn btn-outline btn-small';
  plusBtn.textContent = '＋';

  const quantityInput = document.createElement('input');
  quantityInput.type = 'number';
  quantityInput.min = '0';
  quantityInput.step = '1';
  quantityInput.value = String(item.quantity);
  quantityInput.className = 'equipment-quantity-input';

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-primary btn-small';
  applyBtn.textContent = '更新';

  const errorText = document.createElement('p');
  errorText.className = 'form-error';

  const setBusy = (busy) => {
    minusBtn.disabled = busy || item.quantity <= 0;
    plusBtn.disabled = busy;
    quantityInput.disabled = busy;
    applyBtn.disabled = busy;
  };

  async function saveQuantity(newQuantity) {
    if (!state.myName) {
      errorText.textContent = 'お名前を設定してから変更してください';
      return;
    }
    errorText.textContent = '';
    setBusy(true);

    // 自分自身の更新で発生するRealtime echoを後でsubscribeRealtime側が消化できるよう予約する。
    // echoが届かなかった場合に備え、一定時間後に自動でカウンタを戻すタイマーも仕掛けておく
    state.pendingLocalQuantityUpdates += 1;
    const timeoutId = setTimeout(() => {
      state.pendingLocalQuantityUpdates = Math.max(0, state.pendingLocalQuantityUpdates - 1);
      const idx = state.pendingRealtimeTimeouts.indexOf(timeoutId);
      if (idx !== -1) {
        state.pendingRealtimeTimeouts.splice(idx, 1);
      }
    }, REALTIME_ECHO_TIMEOUT_MS);
    state.pendingRealtimeTimeouts.push(timeoutId);

    try {
      await api.updateEquipment(item.id, {
        quantity: newQuantity,
        updated_by: state.myName,
        password: state.password,
      });

      item.quantity = newQuantity;
      quantityInput.value = String(item.quantity);

      const quantityP = detail.querySelector('.equipment-quantity');
      if (quantityP) {
        quantityP.textContent = item.is_countable
          ? `数量: ${item.quantity} ・ 数量変動あり`
          : `数量: ${item.quantity}`;
      }

      // 一覧タイルビューの詳細パネルだけ、直前の兄弟要素が本物のタイル(.equipment-tile)になる。
      // 種類別・在庫確認では前の兄弟がnullか別itemのdetailパネルなので、そこでは何もしない
      const tile = detail.previousElementSibling;
      if (tile && tile.classList.contains('equipment-tile')) {
        updateTileQuantityDisplay(tile, item.quantity);
      }

      setBusy(false);
    } catch (err) {
      // 更新自体が失敗した場合はDBが変わっておらずechoも来ないので、予約したタイマー/カウンタをその場で巻き戻す
      clearTimeout(timeoutId);
      const idx = state.pendingRealtimeTimeouts.indexOf(timeoutId);
      if (idx !== -1) {
        state.pendingRealtimeTimeouts.splice(idx, 1);
      }
      state.pendingLocalQuantityUpdates = Math.max(0, state.pendingLocalQuantityUpdates - 1);

      errorText.textContent = err.message;
      setBusy(false);
    }
  }

  minusBtn.addEventListener('click', () => {
    if (item.quantity <= 0) return;
    saveQuantity(item.quantity - 1);
  });
  plusBtn.addEventListener('click', () => {
    saveQuantity(item.quantity + 1);
  });
  applyBtn.addEventListener('click', () => {
    const parsed = Number(quantityInput.value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errorText.textContent = '0以上の数量を入力してください';
      return;
    }
    saveQuantity(Math.round(parsed));
  });

  setBusy(false);

  const row = document.createElement('div');
  row.className = 'equipment-quantity-adjuster-row';
  row.appendChild(minusBtn);
  row.appendChild(plusBtn);
  row.appendChild(quantityInput);
  row.appendChild(applyBtn);

  wrap.appendChild(row);
  wrap.appendChild(errorText);
  return wrap;
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

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = item.item_name;
  nameInput.placeholder = '品目名';

  const managementNumberInput = document.createElement('input');
  managementNumberInput.type = 'text';
  managementNumberInput.value = item.management_number || '';
  managementNumberInput.placeholder = '管理番号（任意）';

  const quantityInput = document.createElement('input');
  quantityInput.type = 'number';
  quantityInput.min = '0';
  quantityInput.step = '1';
  quantityInput.value = String(item.quantity ?? 1);

  const quantityLabel = document.createElement('label');
  quantityLabel.textContent = '数量';
  quantityLabel.appendChild(quantityInput);

  const isCountableInput = document.createElement('input');
  isCountableInput.type = 'checkbox';
  isCountableInput.checked = Boolean(item.is_countable);

  const isCountableLabel = document.createElement('label');
  isCountableLabel.className = 'checkbox-label';
  isCountableLabel.appendChild(isCountableInput);
  isCountableLabel.appendChild(document.createTextNode('数量変動あり'));

  const ownerBranchSelect = document.createElement('select');
  populateOwnerBranchSelect(ownerBranchSelect, { includeBlank: true, blankLabel: '未定' });
  ownerBranchSelect.value = item.owner_branch || '';

  const isSharedInput = document.createElement('input');
  isSharedInput.type = 'checkbox';
  isSharedInput.checked = Boolean(item.is_shared);

  const isSharedLabel = document.createElement('label');
  isSharedLabel.className = 'checkbox-label';
  isSharedLabel.appendChild(isSharedInput);
  isSharedLabel.appendChild(document.createTextNode('全体で使用'));

  ownerBranchSelect.addEventListener('change', () => {
    syncIsSharedCheckbox(ownerBranchSelect, isSharedInput);
  });
  syncIsSharedCheckbox(ownerBranchSelect, isSharedInput);

  const ownerPersonInput = document.createElement('input');
  ownerPersonInput.type = 'text';
  ownerPersonInput.value = item.owner_person || '';
  ownerPersonInput.placeholder = '担当者名（任意）';

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
        quantity: quantityInput.value,
        is_countable: isCountableInput.checked,
        location: locationInput.value.trim(),
        memo: memoInput.value.trim(),
        owner_branch: ownerBranchSelect.value,
        owner_person: ownerPersonInput.value.trim(),
        is_shared: isSharedInput.checked,
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

  detail.appendChild(imagePreview);
  detail.appendChild(imageFileInput);
  detail.appendChild(imageCameraBtn);
  detail.appendChild(imageCameraInput);
  detail.appendChild(nameInput);
  detail.appendChild(managementNumberInput);
  detail.appendChild(quantityLabel);
  detail.appendChild(isCountableLabel);
  detail.appendChild(ownerBranchSelect);
  detail.appendChild(isSharedLabel);
  detail.appendChild(ownerPersonInput);
  detail.appendChild(locationInput);
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
      quantity: els.itemQuantity.value,
      is_countable: els.itemIsCountable.checked,
      location: els.itemLocation.value.trim(),
      image_url: imageUrl,
      memo: els.itemMemo.value.trim(),
      owner_branch: els.itemOwnerBranch.value,
      owner_person: els.itemOwnerPerson.value.trim(),
      is_shared: els.itemIsShared.checked,
      updated_by: updatedBy,
      password: state.password,
    });

    els.itemForm.reset();
    state.selectedImageFile = null;
    els.itemImagePreview.classList.remove('visible');
    els.itemForm.classList.add('hidden');
    els.newItemToggleBtn.textContent = '＋ 備品を登録';
    syncIsSharedCheckbox(els.itemOwnerBranch, els.itemIsShared);
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
