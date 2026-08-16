import { BRANCHES } from './branches.js';
import { getSupabaseClient } from './supabase-client.js';
import { api } from './api.js';
import {
  CATEGORY_OPTIONS,
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
  viewMode: 'list',
  supabase: null,
  realtimeChannel: null,
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
  calendarMonthLabel: document.getElementById('calendar-month-label'),
  prevMonthBtn: document.getElementById('prev-month-btn'),
  nextMonthBtn: document.getElementById('next-month-btn'),
  calendarWeekdays: document.getElementById('calendar-weekdays'),
  calendarGrid: document.getElementById('calendar-grid'),
  selectedDateLabel: document.getElementById('selected-date-label'),
  viewListBtn: document.getElementById('view-list-btn'),
  viewTimelineBtn: document.getElementById('view-timeline-btn'),
  eventList: document.getElementById('event-list'),
  timelineView: document.getElementById('timeline-view'),
  newEventToggleBtn: document.getElementById('new-event-toggle-btn'),
  eventForm: document.getElementById('event-form'),
  eventFormError: document.getElementById('event-form-error'),
  eventTime: document.getElementById('event-time'),
  eventEndTime: document.getElementById('event-end-time'),
  eventPlace: document.getElementById('event-place'),
  eventContent: document.getElementById('event-content'),
  eventCategorySelect: document.getElementById('event-category-select'),
  eventCategoryOtherWrap: document.getElementById('event-category-other-wrap'),
  eventCategoryOther: document.getElementById('event-category-other'),
  eventPosterName: document.getElementById('event-poster-name'),
};

init();

async function init() {
  populateBranchOptions();
  populateCategorySelect(els.eventCategorySelect);
  bindCategoryToggle(els.eventCategorySelect, els.eventCategoryOtherWrap);
  renderWeekdayHeader();
  await loadHolidays();
  bindStaticEvents();
  restoreSession();
}

function populateCategorySelect(selectEl) {
  for (const category of CATEGORY_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = category;
    opt.textContent = category;
    selectEl.appendChild(opt);
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
    await refreshMonthDates();
    await refreshEvents();
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
}

function saveNameEdit() {
  state.myName = els.nameInput.value.trim();
  localStorage.setItem('aichi-schedule:name', state.myName);
  updateNameDisplay();
  els.nameEditWrap.classList.add('hidden');
  els.nameDisplayBtn.classList.remove('hidden');
  renderCurrentView();
}

function updateNameDisplay() {
  els.nameDisplayValue.textContent = state.myName || 'お名前未設定';
}

function setViewMode(mode) {
  if (state.viewMode === mode) return;
  state.viewMode = mode;
  els.viewListBtn.classList.toggle('is-active', mode === 'list');
  els.viewListBtn.setAttribute('aria-selected', String(mode === 'list'));
  els.viewTimelineBtn.classList.toggle('is-active', mode === 'timeline');
  els.viewTimelineBtn.setAttribute('aria-selected', String(mode === 'timeline'));
  renderCurrentView();
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
    await refreshMonthDates();
    await refreshEvents();
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

  const { data, error } = await state.supabase
    .from('events')
    .select('*, participants(*)')
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
  const target = state.viewMode === 'timeline' ? els.timelineView : els.eventList;
  target.innerHTML = '';
  target.appendChild(hintEl('読み込み中…'));
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
  els.selectedDateLabel.textContent = formatDateLabel(state.selectedDate);
  els.eventList.classList.toggle('hidden', state.viewMode !== 'list');
  els.timelineView.classList.toggle('hidden', state.viewMode !== 'timeline');

  if (state.viewMode === 'timeline') {
    renderTimelineBody(errorMessage);
  } else {
    renderListBody(errorMessage);
  }
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
  els.viewListBtn.classList.add('is-active');
  els.viewListBtn.setAttribute('aria-selected', 'true');
  els.viewTimelineBtn.classList.remove('is-active');
  els.viewTimelineBtn.setAttribute('aria-selected', 'false');
  renderCurrentView();

  requestAnimationFrame(() => {
    const cardEl = els.eventList.querySelector(`[data-event-id="${eventId}"]`);
    if (!cardEl) return;
    cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    cardEl.classList.add('event-card-highlight');
    setTimeout(() => cardEl.classList.remove('event-card-highlight'), 1500);
  });
}

function hintEl(text) {
  const p = document.createElement('p');
  p.className = 'hint-text';
  p.textContent = text;
  return p;
}

function createEventCard(event) {
  const card = document.createElement('article');
  card.className = 'event-card';
  card.dataset.eventId = event.id;
  if (event.finished_at) {
    card.classList.add('is-finished');
  }

  const header = document.createElement('div');
  header.className = 'event-card-header';
  const time = document.createElement('span');
  time.className = 'event-time';
  time.textContent = event.end_time
    ? `${event.time.slice(0, 5)}〜${event.end_time.slice(0, 5)}`
    : event.time.slice(0, 5);
  const place = document.createElement('span');
  place.className = 'event-place';
  place.textContent = event.place;
  header.appendChild(time);
  header.appendChild(place);
  if (event.finished_at) {
    const finishedBadge = document.createElement('span');
    finishedBadge.className = 'finished-badge';
    finishedBadge.textContent = '終了済み';
    header.appendChild(finishedBadge);
  }
  if (event.category) {
    header.appendChild(createCategoryBadge(event.category));
  }
  card.appendChild(header);

  const content = document.createElement('p');
  content.className = 'event-content';
  content.textContent = event.content;
  card.appendChild(content);

  const poster = document.createElement('p');
  poster.className = 'event-poster';
  poster.textContent = `投稿者: ${event.poster_name}`;
  card.appendChild(poster);

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

function createParticipantsSection(event) {
  const section = document.createElement('div');
  section.className = 'participants-section';

  const list = document.createElement('div');
  list.className = 'participants-list';
  for (const p of event.participants) {
    const chip = document.createElement('span');
    chip.className = 'participant-chip';
    chip.textContent = p.participant_name;
    list.appendChild(chip);
  }
  if (event.participants.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'hint-text';
    empty.textContent = 'まだ参加者はいません';
    list.appendChild(empty);
  }

  const joinBtn = document.createElement('button');
  joinBtn.type = 'button';
  joinBtn.className = 'btn btn-outline btn-small';
  const alreadyJoined = event.participants.some((p) => p.participant_name === state.myName);
  joinBtn.textContent = alreadyJoined ? '参加済み' : '参加する';
  joinBtn.disabled = alreadyJoined;
  joinBtn.addEventListener('click', async () => {
    if (!state.myName) {
      alert('先に画面上部で表示名を入力してください');
      return;
    }
    joinBtn.disabled = true;
    try {
      await api.joinEvent({
        event_id: event.id,
        participant_name: state.myName,
        password: state.password,
      });
      await refreshEvents();
    } catch (err) {
      alert(err.message);
      joinBtn.disabled = false;
    }
  });

  section.appendChild(list);
  section.appendChild(joinBtn);
  return section;
}

function createActionsRow(event, card) {
  const row = document.createElement('div');
  row.className = 'event-actions';

  const canEdit = state.role === 'admin' || event.poster_name === state.myName;
  const isParticipant = event.participants.some((p) => p.participant_name === state.myName);
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
        await refreshEvents();
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
        await refreshEvents();
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
        await refreshEvents();
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
      await refreshEvents();
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
  card.appendChild(contentInput);
  card.appendChild(categorySelect);
  card.appendChild(categoryOtherInput);
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
    await refreshMonthDates();
    await refreshEvents();
  } catch (err) {
    els.eventFormError.textContent = err.message;
  }
}

function renderFatalError(message) {
  els.eventList.innerHTML = '';
  els.eventList.appendChild(hintEl(message));
}
