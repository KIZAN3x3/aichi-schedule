import { BRANCHES } from './branches.js';
import { getSupabaseClient } from './supabase-client.js';
import { api, downloadCsv } from './api.js';
import { OWNER_BRANCH_OPTIONS } from './owner-branches.js';
import {
  FIXED_CATEGORIES,
  OTHER_CATEGORY,
  colorForCategory,
  splitCategoryForEdit,
  iconsForCategories,
} from './categories.js';
import {
  toDateStr,
  startOfMonth,
  addMonths,
  formatMonthLabel,
  formatDateLabel,
  formatMonthRange,
  WEEKDAY_LABELS,
} from './date-utils.js';
import { renderTimeline } from './timeline.js';
import { loadHolidays, isHoliday } from './holidays.js';

const PASSWORD_ROLES = { 123: 'user', 123123: 'admin' };
const ROLE_LABELS = { user: '一般', admin: '管理者' };
const MY_EVENTS_DISMISSED_KEY = 'aichi-schedule:myEventsDismissed';
const PARTICIPANT_COMMENT_MAX = 200;

const state = {
  role: null,
  password: null,
  myName: '',
  branch: '',
  selectedDate: toDateStr(new Date()),
  calendarMonth: startOfMonth(new Date()),
  eventDates: new Set(),
  eventCategoriesByDate: new Map(),
  events: [],
  myEvents: [],
  myEventsDismissed: new Set(),
  viewMode: 'list',
  supabase: null,
  realtimeChannel: null,
  branchPlaceOptions: [],
  branchCategoryOptions: [],
  participantDialog: null, // { eventId, status, editing }
  pendingParticipantOpen: null, // 名前未設定で大ボタンを押した場合の再開用 { eventId, status }
  participantsOpen: new Set(), // 開いている予定カードのevent_id（再描画をまたいで開閉状態を保持）
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
  branchSelect: document.getElementById('branch-select'),
  branchOptionsBtn: document.getElementById('branch-options-btn'),
  csvExportBtn: document.getElementById('csv-export-btn'),
  csvExportDialog: document.getElementById('csv-export-dialog'),
  csvExportForm: document.getElementById('csv-export-form'),
  csvExportFrom: document.getElementById('csv-export-from'),
  csvExportTo: document.getElementById('csv-export-to'),
  csvExportBranch: document.getElementById('csv-export-branch'),
  csvExportPeriodWrap: document.getElementById('csv-export-period-wrap'),
  csvExportError: document.getElementById('csv-export-error'),
  csvExportSubmit: document.getElementById('csv-export-submit'),
  csvExportCancel: document.getElementById('csv-export-cancel'),
  participantDialog: document.getElementById('participant-dialog'),
  participantForm: document.getElementById('participant-form'),
  participantTitle: document.getElementById('participant-dialog-title'),
  participantStatusGroup: document.getElementById('participant-status-group'),
  participantStatusRadios: document.querySelectorAll('input[name="participant-status"]'),
  participantName: document.getElementById('participant-name'),
  participantProxyNote: document.getElementById('participant-proxy-note'),
  participantComment: document.getElementById('participant-comment'),
  participantCommentCount: document.getElementById('participant-comment-count'),
  participantError: document.getElementById('participant-error'),
  participantSubmit: document.getElementById('participant-submit'),
  participantCancel: document.getElementById('participant-cancel'),
  calendarMonthLabel: document.getElementById('calendar-month-label'),
  prevMonthBtn: document.getElementById('prev-month-btn'),
  nextMonthBtn: document.getElementById('next-month-btn'),
  calendarWeekdays: document.getElementById('calendar-weekdays'),
  calendarGrid: document.getElementById('calendar-grid'),
  selectedDateLabel: document.getElementById('selected-date-label'),
  viewListBtn: document.getElementById('view-list-btn'),
  viewTimelineBtn: document.getElementById('view-timeline-btn'),
  viewMineBtn: document.getElementById('view-mine-btn'),
  eventList: document.getElementById('event-list'),
  timelineView: document.getElementById('timeline-view'),
  myEventsView: document.getElementById('my-events-view'),
  newEventToggleBtn: document.getElementById('new-event-toggle-btn'),
  eventForm: document.getElementById('event-form'),
  eventFormError: document.getElementById('event-form-error'),
  eventTime: document.getElementById('event-time'),
  eventEndTime: document.getElementById('event-end-time'),
  eventPlace: document.getElementById('event-place'),
  eventPlaceOptions: document.getElementById('event-place-options'),
  eventContent: document.getElementById('event-content'),
  eventCategorySelect: document.getElementById('event-category-select'),
  eventCategoryOtherWrap: document.getElementById('event-category-other-wrap'),
  eventCategoryOther: document.getElementById('event-category-other'),
  eventPosterName: document.getElementById('event-poster-name'),
};

init();

async function init() {
  populateBranchOptions();
  populateCsvExportBranchOptions();
  populateCategorySelect(els.eventCategorySelect);
  bindCategoryToggle(els.eventCategorySelect, els.eventCategoryOtherWrap);
  renderWeekdayHeader();
  await loadHolidays();
  bindStaticEvents();
  bindCsvExportEvents();
  bindParticipantDialogEvents();
  restoreSession();
}

// 固定17種 + その支部の過去の自由入力カテゴリ候補（重複除外） + 「その他」
function buildCategoryOptionList() {
  const custom = state.branchCategoryOptions.filter((c) => !FIXED_CATEGORIES.includes(c));
  return [...FIXED_CATEGORIES, ...custom, OTHER_CATEGORY];
}

function populateCategorySelect(selectEl) {
  // 作成フォーム側は静的な「未選択」(value="")オプションを持つため、それだけ残して他を入れ替える
  for (const opt of [...selectEl.options]) {
    if (opt.value !== '') selectEl.removeChild(opt);
  }
  for (const category of buildCategoryOptionList()) {
    const opt = document.createElement('option');
    opt.value = category;
    opt.textContent = category;
    selectEl.appendChild(opt);
  }
}

async function refreshBranchOptions() {
  if (!state.branch) {
    state.branchPlaceOptions = [];
    state.branchCategoryOptions = [];
    updatePlaceDatalist();
    populateCategorySelect(els.eventCategorySelect);
    return;
  }
  try {
    const [places, categories] = await Promise.all([
      api.getBranchOptions(state.branch, 'place'),
      api.getBranchOptions(state.branch, 'category'),
    ]);
    state.branchPlaceOptions = places.map((row) => row.value);
    state.branchCategoryOptions = categories.map((row) => row.value);
  } catch (err) {
    console.error(err);
    state.branchPlaceOptions = [];
    state.branchCategoryOptions = [];
  }
  updatePlaceDatalist();
  populateCategorySelect(els.eventCategorySelect);
}

function updatePlaceDatalist() {
  els.eventPlaceOptions.innerHTML = '';
  for (const value of state.branchPlaceOptions) {
    const opt = document.createElement('option');
    opt.value = value;
    els.eventPlaceOptions.appendChild(opt);
  }
}

function bindCategoryToggle(selectEl, otherWrapEl) {
  selectEl.addEventListener('change', () => {
    otherWrapEl.classList.toggle('hidden', selectEl.value !== OTHER_CATEGORY);
  });
}

function resolveCategoryValue(selectEl, otherInputEl) {
  if (selectEl.value === OTHER_CATEGORY) {
    return otherInputEl.value.trim();
  }
  return selectEl.value;
}

function populateBranchOptions() {
  for (const branch of BRANCHES) {
    const opt = document.createElement('option');
    opt.value = branch;
    opt.textContent = branch;
    els.branchSelect.appendChild(opt);
  }
}

function renderWeekdayHeader() {
  for (const label of WEEKDAY_LABELS) {
    const cell = document.createElement('div');
    cell.className = 'weekday-cell';
    cell.textContent = label;
    els.calendarWeekdays.appendChild(cell);
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

  els.branchSelect.addEventListener('change', async () => {
    state.branch = els.branchSelect.value;
    localStorage.setItem('aichi-schedule:branch', state.branch);
    await Promise.all([refreshMonthDates(), refreshEvents(), refreshBranchOptions()]);
    subscribeRealtime();
  });

  els.prevMonthBtn.addEventListener('click', () => changeMonth(-1));
  els.nextMonthBtn.addEventListener('click', () => changeMonth(1));

  els.newEventToggleBtn.addEventListener('click', () => {
    const isHidden = els.eventForm.classList.toggle('hidden');
    els.newEventToggleBtn.textContent = isHidden ? '＋ この日に予定を追加' : '閉じる';
    if (!isHidden) {
      els.eventPosterName.value = state.myName;
      els.eventCategorySelect.value = '';
      els.eventCategoryOtherWrap.classList.add('hidden');
      els.eventCategoryOther.value = '';
      els.eventFormError.textContent = '';
    }
  });

  els.eventForm.addEventListener('submit', handleCreateEvent);

  els.logoutBtn.addEventListener('click', handleLogout);

  els.viewListBtn.addEventListener('click', () => setViewMode('list'));
  els.viewTimelineBtn.addEventListener('click', () => setViewMode('timeline'));
  els.viewMineBtn.addEventListener('click', () => setViewMode('mine'));
}

function saveNameEdit() {
  state.myName = els.nameInput.value.trim();
  localStorage.setItem('aichi-schedule:name', state.myName);
  updateNameDisplay();
  els.nameEditWrap.classList.add('hidden');
  els.nameDisplayBtn.classList.remove('hidden');
  if (state.viewMode === 'mine') {
    refreshMyEvents();
  } else {
    renderCurrentView();
  }
  resumePendingParticipantDialog();
}

function updateNameDisplay() {
  els.nameDisplayValue.textContent = state.myName || 'お名前未設定';
}

function setViewMode(mode) {
  if (state.viewMode === mode) return;
  state.viewMode = mode;
  updateViewToggleUI();
  if (mode === 'mine') {
    refreshMyEvents();
  } else {
    renderCurrentView();
  }
}

function updateViewToggleUI() {
  els.viewListBtn.classList.toggle('is-active', state.viewMode === 'list');
  els.viewListBtn.setAttribute('aria-selected', String(state.viewMode === 'list'));
  els.viewTimelineBtn.classList.toggle('is-active', state.viewMode === 'timeline');
  els.viewTimelineBtn.setAttribute('aria-selected', String(state.viewMode === 'timeline'));
  els.viewMineBtn.classList.toggle('is-active', state.viewMode === 'mine');
  els.viewMineBtn.setAttribute('aria-selected', String(state.viewMode === 'mine'));
}

function restoreSession() {
  const savedName = localStorage.getItem('aichi-schedule:name') || '';
  state.myName = savedName;
  updateNameDisplay();

  const savedBranch = localStorage.getItem('aichi-schedule:branch') || '';
  if (savedBranch && BRANCHES.includes(savedBranch)) {
    state.branch = savedBranch;
    els.branchSelect.value = savedBranch;
  }

  state.myEventsDismissed = loadDismissedMyEvents();

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
  els.branchOptionsBtn.classList.toggle('hidden', state.role !== 'admin');
  els.csvExportBtn.classList.toggle('hidden', state.role !== 'admin');
  boot();
}

async function boot() {
  try {
    state.supabase = await getSupabaseClient();
  } catch (err) {
    renderFatalError(err.message);
    return;
  }
  renderCalendar();
  if (state.branch) {
    await Promise.all([refreshMonthDates(), refreshEvents(), refreshBranchOptions()]);
    subscribeRealtime();
  } else {
    renderCurrentView();
  }
}

function changeMonth(diff) {
  state.calendarMonth = addMonths(state.calendarMonth, diff);
  renderCalendar();
  refreshMonthDates();
}

async function refreshMonthDates() {
  state.eventDates = new Set();
  state.eventCategoriesByDate = new Map();
  if (!state.branch || !state.supabase) {
    renderCalendar();
    return;
  }
  const { start, end } = formatMonthRange(state.calendarMonth);
  const { data, error } = await state.supabase
    .from('events')
    .select('date, category')
    .eq('branch', state.branch)
    .gte('date', start)
    .lte('date', end);

  if (error) {
    console.error(error);
  } else {
    state.eventDates = new Set(data.map((row) => row.date));
    for (const row of data) {
      if (!row.category) continue;
      if (!state.eventCategoriesByDate.has(row.date)) {
        state.eventCategoriesByDate.set(row.date, []);
      }
      const categories = state.eventCategoriesByDate.get(row.date);
      if (!categories.includes(row.category)) categories.push(row.category);
    }
  }
  renderCalendar();
}

async function refreshEvents() {
  if (!state.branch) {
    state.events = [];
    renderCurrentView();
    return;
  }
  renderLoadingState();

  // coordinations!coordinations_decided_event_id_fkey(id): この予定が日程調整の決定で
  // 作られたものなら、元になった調整のidが1件だけ入る（無ければ空配列）
  const { data, error } = await state.supabase
    .from('events')
    .select('*, participants(*), coordinations!coordinations_decided_event_id_fkey(id)')
    .eq('branch', state.branch)
    .eq('date', state.selectedDate)
    .order('time', { ascending: true });

  if (error) {
    console.error(error);
    state.events = [];
    renderCurrentView('予定の取得に失敗しました');
    return;
  }
  state.events = data;
  renderCurrentView();
}

function renderLoadingState() {
  const target =
    state.viewMode === 'timeline'
      ? els.timelineView
      : state.viewMode === 'mine'
        ? els.myEventsView
        : els.eventList;
  target.innerHTML = '';
  target.appendChild(hintEl('読み込み中…'));
}

async function refreshCurrentEvents() {
  if (state.viewMode === 'mine') {
    await refreshMyEvents();
  } else {
    await refreshEvents();
  }
}

async function refreshMyEvents() {
  if (!state.myName || !state.supabase) {
    state.myEvents = [];
    renderCurrentView();
    return;
  }
  renderLoadingState();

  const { data: rows, error } = await state.supabase
    .from('participants')
    .select('event_id')
    .eq('participant_name', state.myName)
    .eq('status', 'going');

  if (error) {
    console.error(error);
    state.myEvents = [];
    renderCurrentView('参加予定の取得に失敗しました');
    return;
  }

  const eventIds = [...new Set(rows.map((row) => row.event_id))];
  if (eventIds.length === 0) {
    state.myEvents = [];
    renderCurrentView();
    return;
  }

  const { data, error: eventsError } = await state.supabase
    .from('events')
    .select('*, participants(*)')
    .in('id', eventIds)
    .order('date', { ascending: true })
    .order('time', { ascending: true });

  if (eventsError) {
    console.error(eventsError);
    state.myEvents = [];
    renderCurrentView('参加予定の取得に失敗しました');
    return;
  }
  state.myEvents = data;
  renderCurrentView();
}

function subscribeRealtime() {
  if (state.realtimeChannel) {
    state.supabase.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  if (!state.branch) return;

  state.realtimeChannel = state.supabase
    .channel(`schedule-${state.branch}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'events', filter: `branch=eq.${state.branch}` },
      () => {
        refreshMonthDates();
        refreshEvents();
      }
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'participants' }, (payload) => {
      const eventId = payload.new?.event_id || payload.old?.event_id;
      if (state.events.some((e) => e.id === eventId)) {
        refreshEvents();
      }
      if (state.viewMode === 'mine') {
        refreshMyEvents();
      }
    })
    .subscribe();
}

function renderCalendar() {
  els.calendarMonthLabel.textContent = formatMonthLabel(state.calendarMonth);
  els.calendarGrid.innerHTML = '';

  const year = state.calendarMonth.getFullYear();
  const month = state.calendarMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = toDateStr(new Date());

  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'day-cell day-cell-empty';
    els.calendarGrid.appendChild(blank);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = toDateStr(new Date(year, month, day));
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day-cell';
    if (dateStr === todayStr) cell.classList.add('is-today');
    if (dateStr === state.selectedDate) cell.classList.add('is-selected');

    const weekday = new Date(year, month, day).getDay();
    if (weekday === 0 || isHoliday(dateStr)) {
      cell.classList.add('is-sunday-or-holiday');
    } else if (weekday === 6) {
      cell.classList.add('is-saturday');
    }

    const num = document.createElement('span');
    num.className = 'day-number';
    num.textContent = String(day);
    cell.appendChild(num);

    if (state.eventDates.has(dateStr)) {
      const categories = state.eventCategoriesByDate.get(dateStr) || [];
      if (categories.length > 0) {
        cell.appendChild(createDayCategoryIcons(categories));
      } else {
        const dot = document.createElement('span');
        dot.className = 'day-dot';
        cell.appendChild(dot);
      }
    }

    cell.addEventListener('click', () => selectDate(dateStr));
    els.calendarGrid.appendChild(cell);
  }
}

const MAX_DAY_CATEGORY_ICONS = 3;

function createDayCategoryIcons(categories) {
  const wrap = document.createElement('span');
  wrap.className = 'day-cat-icons';

  const shown = categories.slice(0, MAX_DAY_CATEGORY_ICONS);
  const iconLabels = iconsForCategories(shown);

  for (const category of shown) {
    const icon = document.createElement('span');
    icon.className = 'day-cat-icon';
    icon.textContent = iconLabels[category];
    icon.style.backgroundColor = colorForCategory(category);
    icon.title = category;
    wrap.appendChild(icon);
  }

  const overflow = categories.length - shown.length;
  if (overflow > 0) {
    const more = document.createElement('span');
    more.className = 'day-cat-icon day-cat-icon-more';
    more.textContent = `+${overflow}`;
    more.title = categories.slice(MAX_DAY_CATEGORY_ICONS).join('、');
    wrap.appendChild(more);
  }

  return wrap;
}

function selectDate(dateStr) {
  state.selectedDate = dateStr;
  els.eventForm.classList.add('hidden');
  els.newEventToggleBtn.textContent = '＋ この日に予定を追加';
  renderCalendar();
  refreshEvents();
}

function renderCurrentView(errorMessage) {
  els.selectedDateLabel.textContent =
    state.viewMode === 'mine' ? '参加予定のイベント' : formatDateLabel(state.selectedDate);
  els.eventList.classList.toggle('hidden', state.viewMode !== 'list');
  els.timelineView.classList.toggle('hidden', state.viewMode !== 'timeline');
  els.myEventsView.classList.toggle('hidden', state.viewMode !== 'mine');
  els.newEventToggleBtn.classList.toggle('hidden', state.viewMode === 'mine');

  if (state.viewMode === 'timeline') {
    renderTimelineBody(errorMessage);
  } else if (state.viewMode === 'mine') {
    renderMyEventsBody(errorMessage);
  } else {
    renderListBody(errorMessage);
  }
}

function loadDismissedMyEvents() {
  try {
    const raw = localStorage.getItem(MY_EVENTS_DISMISSED_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch (err) {
    console.error(err);
    return new Set();
  }
}

function saveDismissedMyEvents() {
  localStorage.setItem(MY_EVENTS_DISMISSED_KEY, JSON.stringify([...state.myEventsDismissed]));
}

function renderMyEventsBody(errorMessage) {
  els.myEventsView.innerHTML = '';

  if (!state.myName) {
    els.myEventsView.appendChild(hintEl('先に画面上部で表示名を入力してください'));
    return;
  }
  if (errorMessage) {
    els.myEventsView.appendChild(hintEl(errorMessage));
    return;
  }
  const visibleEvents = state.myEvents.filter((event) => !state.myEventsDismissed.has(event.id));
  if (visibleEvents.length === 0) {
    els.myEventsView.appendChild(hintEl('参加予定のイベントはありません'));
    return;
  }

  for (const event of visibleEvents) {
    els.myEventsView.appendChild(createMyEventRow(event));
  }
}

function formatMyEventDateTime(event) {
  const [y, m, d] = event.date.split('-').map(Number);
  const weekday = WEEKDAY_LABELS[new Date(y, m - 1, d).getDay()];
  return `${m}/${d} (${weekday}) ${event.time.slice(0, 5)}〜`;
}

function createMyEventRow(event) {
  const row = document.createElement('div');
  row.className = 'my-event-row';
  if (event.finished_at) row.classList.add('is-finished');
  row.addEventListener('click', () => navigateToMyEvent(event));

  const info = document.createElement('div');
  info.className = 'my-event-row-info';

  const dateTime = document.createElement('span');
  dateTime.className = 'my-event-row-datetime';
  dateTime.textContent = formatMyEventDateTime(event);
  info.appendChild(dateTime);

  const name = document.createElement('span');
  name.className = 'my-event-row-name';
  name.textContent = event.content;
  info.appendChild(name);

  if (event.finished_at) {
    const badge = document.createElement('span');
    badge.className = 'finished-badge';
    badge.textContent = '終了済み';
    info.appendChild(badge);
  }

  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.className = 'btn btn-muted btn-small';
  leaveBtn.textContent = '参加を取り消す';
  leaveBtn.addEventListener('click', async (clickEvent) => {
    clickEvent.stopPropagation();
    if (!confirm('参加を取り消しますか？')) return;
    leaveBtn.disabled = true;
    try {
      await api.leaveEvent({
        event_id: event.id,
        participant_name: state.myName,
        password: state.password,
      });
      await refreshMyEvents();
    } catch (err) {
      alert(err.message);
      leaveBtn.disabled = false;
    }
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'btn btn-outline btn-small';
  dismissBtn.textContent = '削除';
  dismissBtn.addEventListener('click', (clickEvent) => {
    clickEvent.stopPropagation();
    if (!confirm('この予定を一覧から消しますか？（参加記録は残ります）')) return;
    state.myEventsDismissed.add(event.id);
    saveDismissedMyEvents();
    renderMyEventsBody();
  });

  row.appendChild(info);
  row.appendChild(leaveBtn);
  row.appendChild(dismissBtn);
  return row;
}

async function navigateToMyEvent(event) {
  if (state.branch !== event.branch) {
    state.branch = event.branch;
    els.branchSelect.value = event.branch;
    localStorage.setItem('aichi-schedule:branch', state.branch);
  }
  state.selectedDate = event.date;
  state.viewMode = 'list';
  updateViewToggleUI();

  const [y, m, d] = event.date.split('-').map(Number);
  state.calendarMonth = startOfMonth(new Date(y, m - 1, d));
  renderCalendar();

  await Promise.all([refreshMonthDates(), refreshEvents(), refreshBranchOptions()]);
  subscribeRealtime();

  scrollToEventCard(event.id);
}

function scrollToEventCard(eventId) {
  requestAnimationFrame(() => {
    const cardEl = els.eventList.querySelector(`[data-event-id="${eventId}"]`);
    if (!cardEl) return;
    cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    cardEl.classList.add('event-card-highlight');
    setTimeout(() => cardEl.classList.remove('event-card-highlight'), 1500);
  });
}

function renderListBody(errorMessage) {
  els.eventList.innerHTML = '';

  if (!state.branch) {
    els.eventList.appendChild(hintEl('支部を選択してください'));
    return;
  }
  if (errorMessage) {
    els.eventList.appendChild(hintEl(errorMessage));
    return;
  }
  if (state.events.length === 0) {
    els.eventList.appendChild(hintEl('この日の予定はまだありません'));
    return;
  }

  for (const event of state.events) {
    els.eventList.appendChild(createEventCard(event));
  }
}

function renderTimelineBody(errorMessage) {
  els.timelineView.innerHTML = '';

  if (!state.branch) {
    els.timelineView.appendChild(hintEl('支部を選択してください'));
    return;
  }
  if (errorMessage) {
    els.timelineView.appendChild(hintEl(errorMessage));
    return;
  }
  if (state.events.length === 0) {
    els.timelineView.appendChild(hintEl('この日の予定はまだありません'));
    return;
  }

  renderTimeline(els.timelineView, state.events, handleTimelineBlockClick);
}

function handleTimelineBlockClick(eventId) {
  state.viewMode = 'list';
  updateViewToggleUI();
  renderCurrentView();
  scrollToEventCard(eventId);
}

function hintEl(text) {
  const p = document.createElement('p');
  p.className = 'hint-text';
  p.textContent = text;
  return p;
}

// http:// / https:// のみを対象。正規表現がこの2語をリテラルで要求するため、
// javascript: 等の他スキームは構造的にマッチしない
const URL_RE = /https?:\/\/\S+/g;
// URLの末尾に文が続く場合（「。」「、」「）」等）に誤って取り込まないよう、末尾から除去する
const URL_TRAILING_TRIM_RE = /[)\]}>,.;:!?、。」』】　]+$/;
const URL_DISPLAY_MAX = 40;
const MAPS_HOST_RE = /^https?:\/\/(www\.)?(maps\.app\.goo\.gl|goo\.gl\/maps|(maps\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/i;
const MAP_EXCLUDED_PLACES = new Set(['未定']);

// テキスト中のURLを<a>に、それ以外はテキストノードのまま container に流し込む。
// innerHTMLは使わないため、入力文字列がHTMLとして解釈されることはない
function linkifyInto(container, text) {
  if (!text) return;
  let lastIndex = 0;
  let match;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text))) {
    const start = match.index;
    let url = match[0];
    const trimmed = url.match(URL_TRAILING_TRIM_RE);
    if (trimmed) url = url.slice(0, url.length - trimmed[0].length);
    if (!url) continue;

    if (start > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, start)));
    }
    container.appendChild(createUrlLink(url));
    lastIndex = start + url.length;
    URL_RE.lastIndex = lastIndex; // 末尾を削った分、次の検索開始位置を巻き戻す
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function shortenUrlForDisplay(url) {
  if (MAPS_HOST_RE.test(url)) {
    return '🔗 地図リンクを開く'; // 座標付きの長いURLをそのまま出さない。場所名リンクの📍と区別する文言
  }
  if (url.length <= URL_DISPLAY_MAX) return url;
  return `${url.slice(0, 28)}…${url.slice(-8)}`; // 先頭28字+末尾8字だけ見せる（hrefは短縮しない）
}

function createUrlLink(url) {
  const a = document.createElement('a');
  a.href = url; // href は必ず元のURLそのまま
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.className = 'content-link';
  a.textContent = shortenUrlForDisplay(url);
  a.addEventListener('click', (e) => e.stopPropagation()); // カード側の将来のクリック処理と衝突させない
  return a;
}

// 場所名からGoogleマップ検索を開く要素を作る。空欄・「未定」はリンク化しない
function createPlaceElement(place) {
  const trimmed = (place || '').trim();
  if (!trimmed || MAP_EXCLUDED_PLACES.has(trimmed)) {
    const span = document.createElement('span');
    span.className = 'event-place';
    span.textContent = place;
    return span;
  }
  const a = document.createElement('a');
  a.className = 'event-place event-place-link';
  a.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = place;
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

function createEventCard(event) {
  const card = document.createElement('article');
  card.className = 'event-card';
  card.dataset.eventId = event.id;
  // 左端のアクセントライン用。カテゴリなしの予定はCSS側のフォールバック色を使う
  if (event.category) card.style.setProperty('--event-accent', colorForCategory(event.category));
  if (event.finished_at) {
    card.classList.add('is-finished');
  }

  const header = document.createElement('div');
  header.className = 'event-card-header';
  if (event.category) {
    header.appendChild(createCategoryBadge(event.category));
  }
  const time = document.createElement('span');
  time.className = 'event-time';
  time.textContent = event.end_time
    ? `${event.time.slice(0, 5)}〜${event.end_time.slice(0, 5)}`
    : event.time.slice(0, 5);
  const place = createPlaceElement(event.place);
  header.appendChild(time);
  header.appendChild(place);
  if (event.finished_at) {
    const finishedBadge = document.createElement('span');
    finishedBadge.className = 'finished-badge';
    finishedBadge.textContent = '終了済み';
    header.appendChild(finishedBadge);
  }
  card.appendChild(header);

  const content = document.createElement('p');
  content.className = 'event-content';
  linkifyInto(content, event.content);
  card.appendChild(content);

  const poster = document.createElement('p');
  poster.className = 'event-poster';
  poster.textContent = `投稿者: ${event.poster_name}`;
  card.appendChild(poster);

  // 日程調整の決定で作られた予定にだけ、元の調整へのリンクを出す
  if (event.coordinations && event.coordinations.length > 0) {
    const coordinationLink = document.createElement('a');
    coordinationLink.href = `coordination.html?id=${event.coordinations[0].id}`;
    coordinationLink.className = 'event-coordination-link';
    coordinationLink.textContent = '📅 元の日程調整を見る';
    card.appendChild(coordinationLink);
  }

  card.appendChild(createParticipantsSection(event));
  card.appendChild(createActionsRow(event, card));

  return card;
}

function createCategoryBadge(category) {
  const badge = document.createElement('span');
  badge.className = 'category-badge';
  badge.textContent = category;
  badge.style.backgroundColor = colorForCategory(category);
  return badge;
}

// 自分の行 = 本人の行 または 自分が代理登録した行。管理者も特別扱いしない
function isMyRow(p) {
  if (!state.myName) return false; // 表示名が空のとき、registered_by が空欄の行に誤一致しないため
  return p.participant_name === state.myName || p.registered_by === state.myName;
}

function createParticipantsSection(event) {
  const section = document.createElement('div');
  section.className = 'participants-section';

  const sorted = [...event.participants].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const going = sorted.filter((p) => p.status === 'going');
  const notGoing = sorted.filter((p) => p.status === 'not_going');

  if (sorted.length === 0) {
    section.appendChild(hintEl('まだ参加者はいません'));
  } else {
    section.appendChild(createParticipantsAccordion(event, going, notGoing));
  }

  const buttons = document.createElement('div');
  buttons.className = 'participant-buttons';
  for (const [status, label, cls] of [
    ['going', '✅ 参加 / コメント', 'btn btn-outline btn-small'],
    ['not_going', '❌ 不参加 / コメント', 'btn btn-muted btn-small'],
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener('click', () => openNewParticipantDialog(event.id, status));
    buttons.appendChild(btn);
  }
  section.appendChild(buttons);
  return section;
}

// 閉じた状態は1行のサマリー（「参加 N名 ・ 不参加 N名 ・ 💬コメント数」）のみ表示し、
// タップで開くとこれまでの参加/不参加グループ表示が中に入る
function createParticipantsAccordion(event, going, notGoing) {
  const details = document.createElement('details');
  details.className = 'participants-accordion';
  details.open = state.participantsOpen.has(event.id); // 再描画をまたいで開閉状態を復元

  details.addEventListener('toggle', () => {
    if (details.open) {
      state.participantsOpen.add(event.id);
    } else {
      state.participantsOpen.delete(event.id);
    }
  });

  const summary = document.createElement('summary');
  summary.className = 'participants-summary';

  const text = document.createElement('span');
  text.className = 'participants-summary-text';
  const commentCount = [...going, ...notGoing].filter((p) => p.comment).length;
  const parts = [];
  if (going.length > 0) parts.push(`参加 ${going.length}名`);
  if (notGoing.length > 0) parts.push(`不参加 ${notGoing.length}名`);
  if (commentCount > 0) parts.push(`💬${commentCount}`);
  text.textContent = parts.join(' ・ ');
  summary.appendChild(text);

  const myRow = [...going, ...notGoing].find((p) => p.participant_name === state.myName);
  if (myRow) {
    const mine = document.createElement('span');
    mine.className = 'participants-summary-mine';
    mine.textContent = `あなた：${myRow.status === 'going' ? '参加' : '不参加'}`;
    summary.appendChild(mine);
  }

  const chevron = document.createElement('span');
  chevron.className = 'participants-summary-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▼';
  summary.appendChild(chevron);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'participants-accordion-body';
  body.appendChild(createParticipantGroup(event, '参加', going, 'going'));
  if (notGoing.length > 0) {
    body.appendChild(createParticipantGroup(event, '不参加', notGoing, 'not_going'));
  }
  details.appendChild(body);

  return details;
}

function createParticipantGroup(event, title, rows, status) {
  const group = document.createElement('div');
  group.className = `participant-group participant-group-${status}`;

  const heading = document.createElement('p');
  heading.className = 'participant-group-title';
  heading.textContent = title; // 人数はアコーディオンのサマリー行に出るため、ここでは付けない
  group.appendChild(heading);

  if (rows.length === 0) {
    group.appendChild(hintEl('まだ参加者はいません'));
    return group;
  }
  for (const p of rows) {
    group.appendChild(createParticipantRow(event, p));
  }
  return group;
}

function createParticipantRow(event, p) {
  const row = document.createElement('div');
  row.className = 'participant-row';

  const name = document.createElement('span');
  name.className = 'participant-name';
  name.textContent = p.participant_name; // textContent のみ。HTMLとして解釈されない
  row.appendChild(name);

  if (p.registered_by && p.registered_by !== p.participant_name) {
    const registeredBy = document.createElement('span');
    registeredBy.className = 'participant-registered-by';
    registeredBy.textContent = `（${p.registered_by}さんが登録）`;
    row.appendChild(registeredBy);
  }

  if (isMyRow(p)) {
    const actions = document.createElement('span');
    actions.className = 'participant-row-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-outline btn-small';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', () => openParticipantDialog(event.id, p.status, p));

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-muted btn-small';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', async () => {
      const isSelf = p.participant_name === state.myName;
      const message = isSelf ? '参加を取り消しますか？' : `${p.participant_name}さんの参加を取り消しますか？`;
      if (!confirm(message)) return;
      cancelBtn.disabled = true;
      try {
        await api.leaveEvent({
          event_id: event.id,
          participant_name: p.participant_name, // 代理登録した行では自分の名前とは限らない
          password: state.password,
        });
        await refreshCurrentEvents();
      } catch (err) {
        alert(err.message);
        cancelBtn.disabled = false;
      }
    });

    actions.append(editBtn, cancelBtn);
    row.appendChild(actions);
  }

  if (p.comment) {
    const comment = document.createElement('span');
    comment.className = 'participant-comment';
    linkifyInto(comment, p.comment);
    row.appendChild(comment);
  }
  return row;
}

// 大ボタン（新規登録の入口）。表示名が未設定なら先に名前入力を求め、入力後に自動でモーダルを開く
function openNewParticipantDialog(eventId, status) {
  if (state.myName) {
    openParticipantDialog(eventId, status, null);
    return;
  }
  state.pendingParticipantOpen = { eventId, status };
  alert('先に自分の名前を入力してください（入力後に登録画面が開きます）');
  els.nameDisplayBtn.click(); // 既存の名前編集UIを開く。確定(blur)時に saveNameEdit → resumePendingParticipantDialog
}

function resumePendingParticipantDialog() {
  const pending = state.pendingParticipantOpen;
  state.pendingParticipantOpen = null;
  if (!pending || !state.myName) return;
  openParticipantDialog(pending.eventId, pending.status, null);
}

// editRow が null なら新規登録（名前は編集可・初期値は自分の名前）。あれば既存行の編集（名前は読み取り専用・参加区分を切り替え可）
function openParticipantDialog(eventId, status, editRow) {
  state.participantDialog = { eventId, status, editing: Boolean(editRow) };

  els.participantTitle.textContent = editRow
    ? '参加登録を編集'
    : status === 'going'
      ? '参加として登録'
      : '不参加として登録';

  els.participantStatusGroup.classList.toggle('hidden', !editRow);
  for (const radio of els.participantStatusRadios) {
    radio.checked = editRow ? radio.value === editRow.status : false;
  }

  els.participantName.value = editRow ? editRow.participant_name : state.myName;
  els.participantName.readOnly = Boolean(editRow);
  els.participantComment.value = editRow?.comment || '';
  updateCommentCount();
  updateProxyNote();
  els.participantError.textContent = '';
  els.participantDialog.showModal();
}

function updateCommentCount() {
  const remaining = Math.max(0, PARTICIPANT_COMMENT_MAX - els.participantComment.value.length);
  els.participantCommentCount.textContent = `残り${remaining}文字`;
}

// 名前が自分と違うときだけ「代理登録」と明示する
function updateProxyNote() {
  const name = els.participantName.value.trim();
  const isProxy = Boolean(name) && name !== state.myName;
  els.participantProxyNote.classList.toggle('hidden', !isProxy);
  els.participantProxyNote.textContent = isProxy ? `代理登録になります（登録者: ${state.myName}）` : '';
}

function bindParticipantDialogEvents() {
  els.participantForm.addEventListener('submit', handleParticipantSubmit);
  els.participantCancel.addEventListener('click', () => els.participantDialog.close());
  els.participantName.addEventListener('input', updateProxyNote);
  els.participantComment.addEventListener('input', updateCommentCount);
}

async function handleParticipantSubmit(event) {
  event.preventDefault();
  els.participantError.textContent = '';

  const ctx = state.participantDialog;
  const name = els.participantName.value.trim();
  const comment = els.participantComment.value.trim();
  if (!name) {
    els.participantError.textContent = 'お名前を入力してください';
    return;
  }
  if ([...comment].length > PARTICIPANT_COMMENT_MAX) {
    els.participantError.textContent = `コメントは${PARTICIPANT_COMMENT_MAX}文字以内で入力してください`;
    return;
  }

  // 編集時は選択中の参加区分、新規時は押した大ボタンの区分
  const checked = [...els.participantStatusRadios].find((radio) => radio.checked);
  const status = ctx.editing && checked ? checked.value : ctx.status;

  const payload = {
    event_id: ctx.eventId,
    participant_name: name,
    status,
    registered_by: state.myName, // 必ず操作者本人の名前
    password: state.password,
  };
  // 編集時は空欄=コメント消去として送る。新規時は空欄なら送らない（同名の既存行のコメントを消さないため）
  if (ctx.editing || comment) payload.comment = comment;

  els.participantSubmit.disabled = true; // 連打による二重送信を防ぐ
  try {
    await api.joinEvent(payload);
    els.participantDialog.close();
    await refreshCurrentEvents();
  } catch (err) {
    els.participantError.textContent = err.message; // 409 を含め、APIの日本語メッセージをそのまま表示
  } finally {
    els.participantSubmit.disabled = false;
  }
}

function createActionsRow(event, card) {
  const row = document.createElement('div');
  row.className = 'event-actions';

  const canEdit = state.role === 'admin' || event.poster_name === state.myName;
  const isParticipant = event.participants.some(
    (p) => p.participant_name === state.myName && p.status === 'going'
  );
  const canFinish = canEdit || isParticipant;

  if (!canEdit && !canFinish) return row;

  if (canEdit) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-outline btn-small';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', () => enterEditMode(event, card));
    row.appendChild(editBtn);
  }

  if (!event.finished_at && canFinish) {
    const finishBtn = document.createElement('button');
    finishBtn.type = 'button';
    finishBtn.className = 'btn btn-outline btn-small';
    finishBtn.textContent = '終了';
    finishBtn.addEventListener('click', async () => {
      finishBtn.disabled = true;
      try {
        await api.updateEvent(event.id, {
          finished: true,
          poster_name: event.poster_name,
          password: state.password,
        });
        await refreshCurrentEvents();
      } catch (err) {
        alert(err.message);
        finishBtn.disabled = false;
      }
    });
    row.appendChild(finishBtn);
  } else if (event.finished_at && canFinish) {
    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'btn btn-muted btn-small';
    reopenBtn.textContent = '戻す';
    reopenBtn.addEventListener('click', async () => {
      reopenBtn.disabled = true;
      try {
        await api.updateEvent(event.id, {
          finished: false,
          poster_name: event.poster_name,
          password: state.password,
        });
        await refreshCurrentEvents();
      } catch (err) {
        alert(err.message);
        reopenBtn.disabled = false;
      }
    });
    row.appendChild(reopenBtn);
  }

  if (canEdit) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger btn-small';
    deleteBtn.textContent = '削除';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('この予定を削除しますか？')) return;
      try {
        await api.deleteEvent(event.id, {
          poster_name: event.poster_name,
          password: state.password,
        });
        await refreshMonthDates();
        await refreshCurrentEvents();
      } catch (err) {
        alert(err.message);
      }
    });
    row.appendChild(deleteBtn);
  }

  return row;
}

function enterEditMode(event, card) {
  card.innerHTML = '';
  card.classList.add('event-card-editing');

  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.value = event.time.slice(0, 5);

  const endTimeInput = document.createElement('input');
  endTimeInput.type = 'time';
  endTimeInput.value = event.end_time ? event.end_time.slice(0, 5) : '';

  const placeInput = document.createElement('input');
  placeInput.type = 'text';
  placeInput.value = event.place;
  placeInput.placeholder = '場所';
  placeInput.setAttribute('list', 'event-place-options');

  const contentInput = document.createElement('textarea');
  contentInput.value = event.content;
  contentInput.placeholder = '活動内容';

  const { select: initialCategory, other: initialOther } = splitCategoryForEdit(event.category);

  const categorySelect = document.createElement('select');
  populateCategorySelect(categorySelect);
  categorySelect.value = initialCategory;

  const categoryOtherInput = document.createElement('input');
  categoryOtherInput.type = 'text';
  categoryOtherInput.maxLength = 50;
  categoryOtherInput.placeholder = 'カテゴリ名を入力';
  categoryOtherInput.value = initialOther;
  categoryOtherInput.classList.toggle('hidden', initialCategory !== OTHER_CATEGORY);
  categorySelect.addEventListener('change', () => {
    categoryOtherInput.classList.toggle('hidden', categorySelect.value !== OTHER_CATEGORY);
  });

  const errorText = document.createElement('p');
  errorText.className = 'form-error';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-small';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', async () => {
    try {
      await api.updateEvent(event.id, {
        time: timeInput.value,
        end_time: endTimeInput.value,
        place: placeInput.value.trim(),
        content: contentInput.value.trim(),
        category: resolveCategoryValue(categorySelect, categoryOtherInput),
        poster_name: event.poster_name,
        password: state.password,
      });
      await refreshCurrentEvents();
    } catch (err) {
      errorText.textContent = err.message;
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-outline btn-small';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.addEventListener('click', () => renderCurrentView());

  const actions = document.createElement('div');
  actions.className = 'event-actions';
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  card.appendChild(timeInput);
  card.appendChild(endTimeInput);
  card.appendChild(placeInput);
  card.appendChild(categorySelect);
  card.appendChild(categoryOtherInput);
  card.appendChild(contentInput);
  card.appendChild(errorText);
  card.appendChild(actions);
}

async function handleCreateEvent(event) {
  event.preventDefault();
  els.eventFormError.textContent = '';

  if (!state.branch) {
    els.eventFormError.textContent = '支部を選択してください';
    return;
  }
  const posterName = els.eventPosterName.value.trim();
  if (!posterName) {
    els.eventFormError.textContent = '投稿者名を入力してください';
    return;
  }

  try {
    await api.createEvent({
      branch: state.branch,
      date: state.selectedDate,
      time: els.eventTime.value,
      end_time: els.eventEndTime.value,
      place: els.eventPlace.value.trim(),
      content: els.eventContent.value.trim(),
      category: resolveCategoryValue(els.eventCategorySelect, els.eventCategoryOther),
      poster_name: posterName,
      password: state.password,
    });
    els.eventForm.reset();
    els.eventForm.classList.add('hidden');
    els.eventCategoryOtherWrap.classList.add('hidden');
    els.newEventToggleBtn.textContent = '＋ この日に予定を追加';
    await Promise.all([refreshMonthDates(), refreshEvents(), refreshBranchOptions()]);
  } catch (err) {
    els.eventFormError.textContent = err.message;
  }
}

function renderFatalError(message) {
  els.eventList.innerHTML = '';
  els.eventList.appendChild(hintEl(message));
}

function populateCsvExportBranchOptions() {
  for (const branch of OWNER_BRANCH_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = branch;
    opt.textContent = branch;
    els.csvExportBranch.appendChild(opt);
  }
}

function updateCsvExportPeriodState(isEquipment) {
  els.csvExportFrom.disabled = isEquipment;
  els.csvExportTo.disabled = isEquipment;
  els.csvExportPeriodWrap.classList.toggle('csv-export-period-disabled', isEquipment);
}

function bindCsvExportEvents() {
  els.csvExportBtn.addEventListener('click', () => {
    els.csvExportError.textContent = '';
    els.csvExportDialog.showModal();
  });

  els.csvExportCancel.addEventListener('click', () => {
    els.csvExportDialog.close();
  });

  const typeRadios = els.csvExportForm.querySelectorAll('input[name="csv-export-type"]');
  for (const radio of typeRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        updateCsvExportPeriodState(radio.value === 'equipment');
      }
    });
  }

  els.csvExportForm.addEventListener('submit', handleCsvExportSubmit);
}

async function handleCsvExportSubmit(event) {
  event.preventDefault();
  els.csvExportError.textContent = '';

  const type = els.csvExportForm.querySelector('input[name="csv-export-type"]:checked').value;
  const from = els.csvExportFrom.value;
  const to = els.csvExportTo.value;
  const branch = els.csvExportBranch.value;

  if (type !== 'equipment') {
    if (!from || !to) {
      els.csvExportError.textContent = '開始日と終了日を指定してください';
      return;
    }
    if (from > to) {
      els.csvExportError.textContent = '開始日は終了日より前にしてください';
      return;
    }
  }

  els.csvExportSubmit.disabled = true;
  els.csvExportSubmit.textContent = '出力中...';
  try {
    await downloadCsv({
      password: state.password,
      type,
      from: type === 'equipment' ? '' : from,
      to: type === 'equipment' ? '' : to,
      branch,
    });
    els.csvExportDialog.close();
  } catch (err) {
    els.csvExportError.textContent = err.message;
  } finally {
    els.csvExportSubmit.disabled = false;
    els.csvExportSubmit.textContent = '出力する';
  }
}
