import { BRANCHES } from './branches.js';
import { getSupabaseClient } from './supabase-client.js';
import { CATEGORY_OPTIONS, OTHER_CATEGORY } from './categories.js';
import { formatDateWithWeekday } from './date-utils.js';
import { replaceChatworkBrackets, chatworkInfo, createShareActions as createCopyButtons } from './share.js';
import { createOptionPicker } from './equipment-options.js';
import {
  getAuthHeaders,
  redirectToLogin,
  setupGoogleLogin,
  loadGoogleAccount,
  showAccountGate,
  googleLogout,
  lockHeaderName,
  roleLabelOf,
  legacyRoleOf,
  canActOnRowFront,
} from './auth.js';

const MARK_LABELS = { yes: '〇', maybe: '△', no: '✕' };
const MARK_ARIA_LABELS = { yes: '参加できる', maybe: '未定', no: '参加できない' };
const COMMENT_MAX = 200;
const CANDIDATE_NOTE_MAX = 50;
// 候補日の最低件数と、その不足時の文言（api/coordinations.js の MIN_CANDIDATES / 文言と完全に一致させること）
const MIN_CANDIDATES = 2;
const MIN_CANDIDATES_MESSAGE =
  '日程調整は候補日を2つ以上入れてください。日にちが決まっている場合は、スケジュール画面から予定として登録してください。';

// api/*.js への薄いラッパー（js/api.jsのrequest()と同じ実装。このページ単体で完結させるため複製している）
// 呼ぶたびに最新のアクセストークンを Authorization: Bearer で付ける。401ならログイン画面に戻す
async function request(path, method, body) {
  const options = { method, headers: await getAuthHeaders() };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    const err = new Error((data && data.error) || `エラーが発生しました (${res.status})`);
    err.status = res.status; // 404（ブラインドの調整が見られない・見つからない）を見分けるため
    throw err;
  }
  return data;
}

const api = {
  createCoordination: (payload) => request('/api/coordinations', 'POST', payload),
  // Vercel Hobbyプランの関数数上限のため、api/coordinations/[id].js・[id]/decide.js を
  // api/coordinations.js に統合した。パス区切りの代わりにクエリ文字列(?id=&action=)で分岐する
  updateCoordination: (id, payload) => request(`/api/coordinations?id=${encodeURIComponent(id)}`, 'PUT', payload),
  deleteCoordination: (id, payload) => request(`/api/coordinations?id=${encodeURIComponent(id)}`, 'DELETE', payload),
  decideCoordination: (id, payload) =>
    request(`/api/coordinations?id=${encodeURIComponent(id)}&action=decide`, 'POST', payload),
  submitResponse: (payload) => request('/api/coordination-responses', 'POST', payload),
  deleteResponse: (payload) => request('/api/coordination-responses', 'DELETE', payload),
  // 支部ごとの「参加できる人の範囲」の候補（migration 0022）。[{ id, value }]
  getAudienceOptions: (branch) =>
    request(`/api/branch-options?branch=${encodeURIComponent(branch)}&type=audience`, 'GET'),
  // ブラインドの調整（migration 0023）は RLS で anon から見えないため、API から取る（見てよい人の分だけ返る）
  getBlindCoordinations: (branch) => request(`/api/coordinations?branch=${encodeURIComponent(branch)}`, 'GET'),
  getCoordinationByToken: (token) => request(`/api/coordinations?token=${encodeURIComponent(token)}`, 'GET'),
  getCoordinationById: (id) => request(`/api/coordinations?id=${encodeURIComponent(id)}`, 'GET'),
  // スケジュールに載せなかった決定の取り消し（調整中に戻す。migration 0024）
  reopenCoordination: (id) => request(`/api/coordinations?id=${encodeURIComponent(id)}&action=reopen`, 'POST', {}),
  // 利用者の表示名（決定した人の「〇〇さんが決定」用）。[{ id, display_name }]
  getUserNames: (ids) => request(`/api/users?action=names&ids=${ids.map(encodeURIComponent).join(',')}`, 'GET'),
};

// coordinationsとcoordination_candidatesの間には外部キーが2本ある
// （coordination_candidates.coordination_id と coordinations.decided_candidate_id）ため、
// どちらのリレーションを辿るか!<fk名>で明示する（省略するとPGRST201の曖昧エラーになる）。
// decided_event: 決定で作られた予定（decided_event_id経由）。決定情報に予定の時刻を出すために使う（未決定はnull）
const COORDINATION_SELECT =
  '*, coordination_candidates!coordination_candidates_coordination_id_fkey(*), coordination_responses(*, coordination_answers(*)), ' +
  'decided_event:events!coordinations_decided_event_id_fkey(date, time, end_time)';

// URLの?id=は起動時に一度だけ読む。ログイン前後でページ遷移しないSPAのため、
// ログイン後にenterApp()→boot()が呼ばれた時にも同じ値を参照できる
let pendingCoordinationId = new URLSearchParams(location.search).get('id');
// ブラインドの調整の共有リンク（coordination.html?t=<token>）。?id= と違い、URLから消さずに残す
// （まだ回答していない人が読み直しても、同じ調整が出るようにするため）
const shareTokenFromUrl = new URLSearchParams(location.search).get('t');

const state = {
  role: null,
  myName: '', // ログインしている人の表示名（app_users.display_name）
  branch: '',
  coordinations: [],
  supabase: null,
  realtimeChannel: null,
  accordionOpen: new Set(), // 開いている調整カードのid（Realtimeでの再描画をまたいで保持する）
  // 自分の操作（作成・決定）のあと、描画し直した時点でスクロールするカード。
  // requireStatusが指定されていれば、その状態で描画されるまで待つ（古い一覧での空振りを防ぐ）
  pendingScroll: null, // { id, requireStatus }
  endedGroupOpen: false, // 「終わった日程調整」グループの開閉（Realtimeでの再描画をまたいで保持する）
  googleUser: null, // ログインしている利用者（app_usersの行）
  // URLの ?t= のトークン。一覧を読み直すたびに、この調整も API から取って一覧に加える（その支部を表示しているときだけ）。
  // トークンが正しくなかったときは null に戻す
  shareToken: shareTokenFromUrl,
  // 決定した人（decided_by_user_id）→ 表示名。一度取った人は取り直さない（取れなかった人は null を入れて、次から聞かない）
  userNames: new Map(),
  audienceOptions: [], // 選んでいる支部の「参加できる人の範囲」の候補（値の配列）
  createAudiencePicker: null, // 作成フォームの範囲の入力欄（選択肢＋新しく入力）
  editAudiencePicker: null, // 編集ダイアログの範囲の入力欄
};

const els = {
  bootLoading: document.getElementById('boot-loading'),
  loginScreen: document.getElementById('login-screen'),
  loginError: document.getElementById('login-error'),
  app: document.getElementById('app'),
  roleDot: document.getElementById('role-dot'),
  roleText: document.getElementById('role-text'),
  logoutBtn: document.getElementById('logout-btn'),
  nameDisplayValue: document.getElementById('name-display-value'),
  branchSelect: document.getElementById('branch-select'),
  newCoordinationToggleBtn: document.getElementById('new-coordination-toggle-btn'),
  coordinationForm: document.getElementById('coordination-form'),
  coordinationTitle: document.getElementById('coordination-title'),
  coordinationCandidatesList: document.getElementById('coordination-candidates-list'),
  coordinationAddCandidateBtn: document.getElementById('coordination-add-candidate-btn'),
  coordinationPlace: document.getElementById('coordination-place'),
  coordinationContent: document.getElementById('coordination-content'),
  coordinationDeadline: document.getElementById('coordination-deadline'),
  coordinationAudiencePicker: document.getElementById('coordination-audience-picker'),
  coordinationBlind: document.getElementById('coordination-blind'),
  coordinationCreatedBy: document.getElementById('coordination-created-by'),
  coordinationFormError: document.getElementById('coordination-form-error'),
  coordinationList: document.getElementById('coordination-list'),
  answerDialog: document.getElementById('answer-dialog'),
  answerForm: document.getElementById('answer-form'),
  answerDialogTitle: document.getElementById('answer-dialog-title'),
  answerAudience: document.getElementById('answer-audience'),
  answerName: document.getElementById('answer-name'),
  answerProxyNote: document.getElementById('answer-proxy-note'),
  answerCandidatesList: document.getElementById('answer-candidates-list'),
  answerComment: document.getElementById('answer-comment'),
  answerCommentCount: document.getElementById('answer-comment-count'),
  answerError: document.getElementById('answer-error'),
  answerSubmit: document.getElementById('answer-submit'),
  answerCancel: document.getElementById('answer-cancel'),
  answerDelete: document.getElementById('answer-delete'),
  decideDialog: document.getElementById('decide-dialog'),
  decideForm: document.getElementById('decide-form'),
  decideTime: document.getElementById('decide-time'),
  decideEndTime: document.getElementById('decide-end-time'),
  decidePlace: document.getElementById('decide-place'),
  decideContent: document.getElementById('decide-content'),
  decideCategorySelect: document.getElementById('decide-category-select'),
  decideCategoryOtherWrap: document.getElementById('decide-category-other-wrap'),
  decideCategoryOther: document.getElementById('decide-category-other'),
  decideDecidedBy: document.getElementById('decide-decided-by'),
  decideRegisterYes: document.getElementById('decide-register-yes'),
  decideRegisterMaybe: document.getElementById('decide-register-maybe'),
  decideError: document.getElementById('decide-error'),
  decideScheduleYes: document.getElementById('decide-schedule-yes'),
  decideScheduleNo: document.getElementById('decide-schedule-no'),
  decideScheduleNote: document.getElementById('decide-schedule-note'),
  decideScheduleFields: document.getElementById('decide-schedule-fields'),
  decideSubmit: document.getElementById('decide-submit'),
  decideCancel: document.getElementById('decide-cancel'),
  editDialog: document.getElementById('edit-dialog'),
  editForm: document.getElementById('edit-form'),
  editTitle: document.getElementById('edit-title'),
  editCandidatesList: document.getElementById('edit-candidates-list'),
  editAddCandidateBtn: document.getElementById('edit-add-candidate-btn'),
  editPlace: document.getElementById('edit-place'),
  editContent: document.getElementById('edit-content'),
  editDeadline: document.getElementById('edit-deadline'),
  editAudiencePicker: document.getElementById('edit-audience-picker'),
  editBlind: document.getElementById('edit-blind'),
  editError: document.getElementById('edit-error'),
  editSubmit: document.getElementById('edit-submit'),
  editCancel: document.getElementById('edit-cancel'),
};

let candidateRowSeq = 0;
let answerDialogCtx = null; // { coordinationId, coordination, editingResponse }
let decideDialogCtx = null; // { coordinationId, candidateId }
let editDialogCtx = null; // { coordinationId }

init();

async function init() {
  populateBranchOptions();
  populateCategorySelect();
  bindCategoryToggle();
  setupAudiencePickers();
  bindStaticEvents();
  setupGoogleLogin();
  bindCoordinationForm();
  bindAnswerDialog();
  bindDecideDialog();
  bindEditDialog();
  restoreSession();
}

function populateBranchOptions() {
  for (const branch of BRANCHES) {
    const opt = document.createElement('option');
    opt.value = branch;
    opt.textContent = branch;
    els.branchSelect.appendChild(opt);
  }
}

function populateCategorySelect() {
  for (const category of CATEGORY_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = category;
    opt.textContent = category;
    els.decideCategorySelect.appendChild(opt);
  }
}

function bindCategoryToggle() {
  els.decideCategorySelect.addEventListener('change', () => {
    const isOther = els.decideCategorySelect.value === OTHER_CATEGORY;
    els.decideCategoryOtherWrap.classList.toggle('hidden', !isOther);
    if (!isOther) els.decideCategoryOther.value = '';
  });
}

// 「参加できる人の範囲」の入力欄（選択肢＋新しく入力。備品の品名と同じ部品）を作成フォームと編集ダイアログに置く
function setupAudiencePickers() {
  const options = {
    blankLabel: '指定なし',
    newLabel: '＋ 新しい範囲を入力',
    inputPlaceholder: '例：支部役員のみ',
    currentSuffix: '（今の範囲）',
    ariaLabel: '参加できる人の範囲',
  };
  state.createAudiencePicker = createOptionPicker(options);
  state.editAudiencePicker = createOptionPicker(options);
  els.coordinationAudiencePicker.appendChild(state.createAudiencePicker.el);
  els.editAudiencePicker.appendChild(state.editAudiencePicker.el);
  state.createAudiencePicker.setChoices([], null);
  state.editAudiencePicker.setChoices([], null);
}

// 選んでいる支部の範囲の候補を読み込み、作成フォームの選択肢を入れ替える（選んでいた値はできるだけ保つ）。
// 編集ダイアログは、開くときにこの候補で作り直す（開いている間は入れ替えない。「（今の範囲）」の選択を保つため）。
// 読み込めなくても作成・編集はできる（選択肢が「指定なし」と「新しく入力」だけになる）
async function loadAudienceOptions() {
  const branch = state.branch;
  let values = [];
  if (branch) {
    try {
      const rows = await api.getAudienceOptions(branch);
      values = (rows || []).map((row) => row.value);
    } catch (err) {
      console.error(err);
    }
  }
  if (branch !== state.branch) return; // 読み込み中に支部が変わった
  state.audienceOptions = values;
  state.createAudiencePicker.setChoices(values);
}

function bindStaticEvents() {
  els.logoutBtn.addEventListener('click', handleLogout);

  els.branchSelect.addEventListener('change', () => {
    state.branch = els.branchSelect.value;
    // 手動での支部切り替えは、これまでどおりlocalStorageに保存する
    // （?id=で開いた際の「画面表示だけ」の切り替えとは区別する。詳しくはopenSharedCoordination参照）
    localStorage.setItem('aichi-schedule:branch', state.branch);
    state.accordionOpen.clear();
    state.pendingScroll = null;
    state.endedGroupOpen = false;
    refreshList();
    loadAudienceOptions();
    subscribeRealtime();
  });

  els.newCoordinationToggleBtn.addEventListener('click', () => {
    const willShow = els.coordinationForm.classList.contains('hidden');
    els.coordinationForm.classList.toggle('hidden', !willShow);
    els.newCoordinationToggleBtn.textContent = willShow ? 'キャンセル' : '＋ 日程調整を作成';
    if (willShow) resetCoordinationForm();
  });
}

async function restoreSession() {
  const savedBranch = localStorage.getItem('aichi-schedule:branch') || '';
  if (savedBranch && BRANCHES.includes(savedBranch)) {
    state.branch = savedBranch;
    els.branchSelect.value = savedBranch;
  }

  // Googleでログインしているかを調べ、利用者の状態で画面を出し分ける
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
  state.role = legacyRoleOf(account.user);
  state.myName = account.user.display_name;
  lockHeaderName(els, account.user);
  enterApp();
}

function handleLogout() {
  googleLogout(); // Googleのセッションを消してページを読み直す
}

function enterApp() {
  els.loginScreen.classList.add('hidden');
  els.app.classList.remove('hidden');
  els.roleText.textContent = roleLabelOf(state.googleUser);
  els.roleDot.classList.toggle('admin', state.role === 'admin');
  boot();
}

async function boot() {
  try {
    state.supabase = await getSupabaseClient();
  } catch (err) {
    els.coordinationList.innerHTML = '';
    els.coordinationList.appendChild(hintEl(err.message));
    return;
  }

  // ?t=（ブラインドの共有リンク）・?id=で開かれた場合は、その調整が属する支部を画面表示だけ切り替えて詳細を開く。
  // ログイン前に開いた場合も、restoreSession→enterApp→bootという同じ経路を通るため、
  // ログイン後に自動でここへ戻ってくる（別途のリダイレクト保存は不要）
  if (state.shareToken) {
    await openTokenCoordination(state.shareToken);
  } else if (pendingCoordinationId) {
    const id = pendingCoordinationId;
    pendingCoordinationId = null; // ログアウト→再ログインでもう一度開かないよう、使うのは1回だけ
    await openSharedCoordination(id);
  } else {
    await refreshList();
  }
  loadAudienceOptions(); // ?id=で支部が切り替わった場合もあるため、支部が決まってから読む
  subscribeRealtime();
  // ブラインドの調整の変更は Realtime で届かない（RLSで見えないため）。画面に戻ったときに読み直して追いつく
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.branch) refreshList();
  });
}

// 1件を読む。通常の調整は anon で直接、見つからなければ（ブラインドの調整）API から（見てよい人のときだけ返る）。
// 見つからない・見られないときは null
async function fetchCoordinationById(id) {
  const { data, error } = await state.supabase
    .from('coordinations')
    .select(COORDINATION_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;
  try {
    return await api.getCoordinationById(id);
  } catch (err) {
    if (err.status === 404 || err.status === 400) return null;
    throw err;
  }
}

async function openSharedCoordination(id) {
  let data = null;
  try {
    data = await fetchCoordinationById(id);
  } catch (err) {
    console.error(err);
  }
  removeIdParamFromUrl();

  if (!data) {
    els.coordinationList.innerHTML = '';
    els.coordinationList.appendChild(renderNotFoundBox());
    return;
  }
  await showOpenedCoordination(data);
}

// ?t=<token> で開く（ブラインドの共有リンク）。URLの ?t= は消さない
async function openTokenCoordination(token) {
  let data = null;
  try {
    data = await api.getCoordinationByToken(token);
  } catch (err) {
    if (err.status !== 404) console.error(err);
  }
  if (!data) {
    state.shareToken = null;
    els.coordinationList.innerHTML = '';
    els.coordinationList.appendChild(
      renderNotFoundBox('この日程調整は見つかりませんでした（リンクが正しくないか、削除された可能性があります）')
    );
    return;
  }
  await showOpenedCoordination(data);
}

// 開いた調整の支部に、画面表示だけ切り替えて詳細を開く
async function showOpenedCoordination(data) {
  // 支部の切り替えは画面表示だけ。localStorageのaichi-schedule:branchは書き換えない
  state.branch = data.branch;
  els.branchSelect.value = data.branch;
  state.accordionOpen.add(data.id);
  // スクロールは描画後に予約で行う（対象が「終わった日程調整」の中なら、renderListがグループを開いてから）
  state.pendingScroll = { id: data.id, requireStatus: null };

  await refreshList();
}

// 開いたあとは?id=をURLから消す（再読み込みで何度も同じ調整へ飛ばないように。スケジュール画面の?event=と同じ）
function removeIdParamFromUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has('id')) return;
  url.searchParams.delete('id');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

function renderNotFoundBox(message = 'この日程調整は見つかりませんでした（削除された可能性があります）') {
  const box = document.createElement('div');
  box.className = 'coordination-not-found';
  box.appendChild(hintEl(message));
  const backLink = document.createElement('a');
  backLink.href = 'coordination.html';
  backLink.className = 'btn btn-outline btn-small';
  backLink.textContent = '一覧へ戻る';
  box.appendChild(backLink);
  return box;
}

function scrollToCoordinationCard(id) {
  requestAnimationFrame(() => {
    const cardEl = els.coordinationList.querySelector(`[data-coordination-id="${id}"]`);
    if (!cardEl) return;
    cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function refreshList() {
  if (!state.branch) {
    els.coordinationList.innerHTML = '';
    els.coordinationList.appendChild(hintEl('支部を選択してください'));
    return;
  }
  const branch = state.branch;
  // 通常の調整は anon で直接（RLSでブラインドは返らない）。ブラインドは API から、見てよい人の分と ?t= の分を取る。
  // API が失敗しても、通常の調整は今までどおり出す
  const [{ data, error }, blind, shared] = await Promise.all([
    state.supabase
      .from('coordinations')
      .select(COORDINATION_SELECT)
      .eq('branch', branch)
      .order('created_at', { ascending: false }),
    api.getBlindCoordinations(branch).catch((err) => {
      console.error(err);
      return [];
    }),
    state.shareToken
      ? api.getCoordinationByToken(state.shareToken).catch((err) => {
          console.error(err);
          return null;
        })
      : null,
  ]);
  if (branch !== state.branch) return; // 読み込み中に支部が変わった（新しい支部の読み込みに任せる）

  if (error) {
    console.error(error);
    els.coordinationList.innerHTML = '';
    els.coordinationList.appendChild(hintEl('日程調整の取得に失敗しました'));
    return;
  }
  // 同じ調整が重なったら先に入れた方を使う（並び順は renderList の groupCoordinations で決める）
  const byId = new Map();
  for (const c of [...(data || []), ...(blind || []), ...(shared ? [shared] : [])]) {
    if (c.branch === branch && !byId.has(c.id)) byId.set(c.id, c);
  }
  state.coordinations = [...byId.values()];
  await loadDecidedByNames(state.coordinations);
  if (branch !== state.branch) return;
  renderList();
}

// 決定した人の表示名を、まだ取っていない人の分だけ API から取る（取れなくても一覧は出す。名前を出さないだけ）
async function loadDecidedByNames(coordinations) {
  const ids = [
    ...new Set(coordinations.map((c) => c.decided_by_user_id).filter((id) => id && !state.userNames.has(id))),
  ].slice(0, 50); // API が一度に受け付けるのは50件まで（残りは次に読み直したときに取る）
  if (ids.length === 0) return;
  try {
    const rows = await api.getUserNames(ids);
    for (const id of ids) state.userNames.set(id, null);
    for (const row of rows || []) state.userNames.set(row.id, row.display_name);
  } catch (err) {
    console.error(err);
  }
}

function renderList() {
  els.coordinationList.innerHTML = '';
  if (!state.branch) {
    els.coordinationList.appendChild(hintEl('支部を選択してください'));
    return;
  }
  if (state.coordinations.length === 0) {
    els.coordinationList.appendChild(hintEl('この支部の日程調整はまだありません'));
    return;
  }
  const { open, decided, ended } = groupCoordinations(state.coordinations);
  for (const coordination of [...open, ...decided]) {
    els.coordinationList.appendChild(createCoordinationCard(coordination));
  }
  if (ended.length > 0) {
    // スクロール予約の対象が「終わった日程調整」の中にあれば、閉じたままだと見えないため開いておく
    if (state.pendingScroll && ended.some((c) => c.id === state.pendingScroll.id)) {
      state.endedGroupOpen = true;
    }
    els.coordinationList.appendChild(createEndedGroup(ended));
  }
  runPendingScroll();
}

const tokyoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// 日本時間の今日を「YYYY-MM-DD」で返す（候補のdateと文字列のまま比較するため）
function todayInTokyo() {
  return tokyoDateFormatter.format(new Date());
}

function decidedCandidateOf(coordination) {
  if (!coordination.decided_candidate_id) return null;
  return (coordination.coordination_candidates || []).find((c) => c.id === coordination.decided_candidate_id) || null;
}

// 決定済みで、決定した候補の日付が今日（日本時間）より前なら「終わった日程調整」。
// 決定した候補が見つからない場合は念のため終わった扱いにしない（決定済みの並びに残す）
function isEnded(coordination, today) {
  if (coordination.status !== 'decided') return false;
  const candidate = decidedCandidateOf(coordination);
  return Boolean(candidate) && candidate.date < today;
}

// 一覧を3つに分けて並べる
//   open    : 調整中。作成日時の新しい順
//   decided : 決定済み（決定した日が今日以降）。決定した日の近い順 → 時刻の早い順 → 作成日時の新しい順
//   ended   : 終わった日程調整。決定した日の新しい順 → 時刻の遅い順 → 作成日時の新しい順
// 候補の時刻が空（終日）の場合は空文字として比較する（同じ日の中では時刻ありより前に並ぶ）
function groupCoordinations(coordinations) {
  const today = todayInTokyo();
  const byCreatedDesc = (a, b) => new Date(b.created_at) - new Date(a.created_at);
  const dateKey = (c) => decidedCandidateOf(c)?.date || '';
  const timeKey = (c) => decidedCandidateOf(c)?.time || '';

  const open = [];
  const decided = [];
  const ended = [];
  for (const c of coordinations) {
    if (c.status === 'open') open.push(c);
    else if (isEnded(c, today)) ended.push(c);
    else decided.push(c);
  }

  // 決定した候補が見つからない決定済み（通常は起きない）は、決定済みの並びの末尾に回す
  const missingLast = (a, b) => Number(!decidedCandidateOf(a)) - Number(!decidedCandidateOf(b));

  open.sort(byCreatedDesc);
  decided.sort(
    (a, b) =>
      missingLast(a, b) ||
      dateKey(a).localeCompare(dateKey(b)) ||
      timeKey(a).localeCompare(timeKey(b)) ||
      byCreatedDesc(a, b)
  );
  ended.sort(
    (a, b) =>
      dateKey(b).localeCompare(dateKey(a)) || timeKey(b).localeCompare(timeKey(a)) || byCreatedDesc(a, b)
  );
  return { open, decided, ended };
}

// 「終わった日程調整（N件）」のグループ。標準で閉じ、開くと今と同じカードが並ぶ
function createEndedGroup(ended) {
  const details = document.createElement('details');
  details.className = 'coordination-ended-group';
  details.open = state.endedGroupOpen;
  details.addEventListener('toggle', () => {
    state.endedGroupOpen = details.open;
  });

  const summary = document.createElement('summary');
  summary.className = 'coordination-ended-summary';
  const label = document.createElement('span');
  label.className = 'coordination-ended-label';
  label.textContent = `終わった日程調整（${ended.length}件）`;
  const chevron = document.createElement('span');
  chevron.className = 'coordination-ended-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▼';
  summary.append(label, chevron);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'coordination-ended-body';
  for (const coordination of ended) {
    body.appendChild(createCoordinationCard(coordination));
  }
  details.appendChild(body);
  return details;
}

function runPendingScroll() {
  const pending = state.pendingScroll;
  if (!pending) return;
  const coordination = state.coordinations.find((c) => c.id === pending.id);
  if (!coordination) return;
  if (pending.requireStatus && coordination.status !== pending.requireStatus) return;
  state.pendingScroll = null;
  scrollToCoordinationCard(pending.id);
}

function subscribeRealtime() {
  if (state.realtimeChannel) {
    state.supabase.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  if (!state.branch) return;

  state.realtimeChannel = state.supabase
    .channel(`coordinations-${state.branch}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'coordinations', filter: `branch=eq.${state.branch}` },
      () => refreshList()
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'coordination_candidates' }, (payload) => {
      const id = payload.new?.coordination_id || payload.old?.coordination_id;
      if (state.coordinations.some((c) => c.id === id)) refreshList();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'coordination_responses' }, (payload) => {
      const id = payload.new?.coordination_id || payload.old?.coordination_id;
      if (state.coordinations.some((c) => c.id === id)) refreshList();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'coordination_answers' }, () => refreshList())
    // スケジュール画面で予定の時刻などが変わったら、決定情報の表示にすぐ反映する。
    // 決定で作られた予定（decided_event_id）の変更のときだけ読み直す
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'events', filter: `branch=eq.${state.branch}` },
      (payload) => {
        const eventId = payload.new?.id;
        if (eventId && state.coordinations.some((c) => c.decided_event_id === eventId)) refreshList();
      }
    )
    .subscribe();
}

function hintEl(text) {
  const p = document.createElement('p');
  p.className = 'hint-text';
  p.textContent = text;
  return p;
}

// ===================== 日付・URLのフォーマット =====================

// candidate.note（候補の補足。例：午前／午後／撮影日。migration 0016で追加、未入力はnull）の表示:
//   時刻あり・補足あり: 1段目「10/4（土）」 2段目「10:00 午前」
//   時刻あり・補足なし: 1段目「10/4（土）」 2段目「10:00」
//   時刻なし・補足あり: 1段目「9/27（日）」 2段目「午前」（「終日」の代わりに補足を表示）
//   時刻なし・補足なし: 1段目「9/27（日）」 2段目「終日」
function candidateDateParts(candidate) {
  const dateLabel = formatDateWithWeekday(candidate.date);
  if (candidate.time) {
    const timeLabel = candidate.time.slice(0, 5);
    return { dateLabel, secondLine: candidate.note ? `${timeLabel} ${candidate.note}` : timeLabel };
  }
  return { dateLabel, secondLine: candidate.note || '終日' };
}

// 候補日×回答者の表以外（回答ダイアログ・チャットワーク文面・決定済み表示等）で使う1行表記
function formatCandidateLabel(candidate) {
  const { dateLabel, secondLine } = candidateDateParts(candidate);
  return `${dateLabel}${secondLine}`;
}

// 共有リンク。ブラインドの調整はトークンのリンク（?t=）、通常の調整は今までどおり ?id=
function buildCoordinationUrl(coordination) {
  if (coordination.is_blind && coordination.share_token) {
    return new URL(`coordination.html?t=${encodeURIComponent(coordination.share_token)}`, location.href).href;
  }
  return new URL(`coordination.html?id=${coordination.id}`, location.href).href;
}

function buildChatworkText(coordination) {
  const url = buildCoordinationUrl(coordination);
  const candidates = sortedCandidates(coordination);
  // 候補の補足(note)は自由記述のため、[ ] を全角にする
  const candidateLines = candidates.map((c) => `・${replaceChatworkBrackets(formatCandidateLabel(c))}`);
  const deadlineLine = coordination.reply_deadline
    ? `回答締切: ${formatDateWithWeekday(coordination.reply_deadline)}`
    : '回答締切: なし';
  // 範囲（自由入力もあるため [ ] を全角にする）。範囲なしなら行ごと省く
  const audienceLines = coordination.audience ? [`範囲: ${replaceChatworkBrackets(coordination.audience)}`] : [];
  return chatworkInfo(`${coordination.title}（日程調整）`, [
    ...audienceLines,
    '候補日:',
    ...candidateLines,
    deadlineLine,
    `回答はこちら → ${url}`,
  ]);
}

// ===================== URLのリンク化（スケジュール画面と同じ方式） =====================

const URL_RE = /https?:\/\/\S+/g;
const URL_TRAILING_TRIM_RE = /[)\]}>,.;:!?、。」』】　]+$/;
const URL_DISPLAY_MAX = 40;
const MAPS_HOST_RE = /^https?:\/\/(www\.)?(maps\.app\.goo\.gl|goo\.gl\/maps|(maps\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/i;

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
    if (start > lastIndex) container.appendChild(document.createTextNode(text.slice(lastIndex, start)));
    container.appendChild(createUrlLink(url));
    lastIndex = start + url.length;
    URL_RE.lastIndex = lastIndex;
  }
  if (lastIndex < text.length) container.appendChild(document.createTextNode(text.slice(lastIndex)));
}

function shortenUrlForDisplay(url) {
  if (MAPS_HOST_RE.test(url)) return '🔗 地図リンクを開く';
  if (url.length <= URL_DISPLAY_MAX) return url;
  return `${url.slice(0, 28)}…${url.slice(-8)}`;
}

function createUrlLink(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.className = 'content-link';
  a.textContent = shortenUrlForDisplay(url);
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

// ===================== 一覧カード =====================

function sortedCandidates(coordination) {
  return [...coordination.coordination_candidates].sort((a, b) => a.sort_order - b.sort_order);
}

// 編集・削除・決定できるか = 作成した本人か、その支部を管理できる管理者（api/coordinations.js と同じ判定）
function canManage(coordination) {
  return canActOnRowFront(state, { branch: coordination.branch, userIds: [coordination.created_by_user_id] });
}

// 回答を編集・取消できるか = 本人・代理登録した人か、その支部を管理できる管理者（api/coordination-responses.js と同じ判定）
function isMyResponseRow(coordination, response) {
  return canActOnRowFront(state, {
    branch: coordination.branch,
    userIds: [response.participant_user_id, response.registered_by_user_id],
  });
}

// カード全体を<details>で開閉する。閉じた状態は「題名（M/D作成）＋状態バッジ」の1行だけ
function createCoordinationCard(coordination) {
  const card = document.createElement('article');
  card.className = 'coordination-card';
  card.dataset.coordinationId = coordination.id;

  const details = document.createElement('details');
  details.className = 'coordination-card-details';
  details.open = state.accordionOpen.has(coordination.id);
  details.addEventListener('toggle', () => {
    if (details.open) state.accordionOpen.add(coordination.id);
    else state.accordionOpen.delete(coordination.id);
  });

  const summary = document.createElement('summary');
  summary.className = 'coordination-card-summary';

  // 閉じた状態は2段構成。1段目は題名のみ（全幅）、2段目は左に「M/D作成」、右端にバッジと▼
  // （スマホ幅で題名が数文字で折り返して窮屈にならないようにするため）
  const title = document.createElement('h3');
  title.className = 'coordination-title';
  title.textContent = coordination.title;
  summary.appendChild(title);

  // <summary>の中身は記述コンテンツに限られるため、2段目の行はdivではなくspanで作る
  const metaRow = document.createElement('span');
  metaRow.className = 'coordination-card-summary-meta';

  const created = document.createElement('span');
  created.className = 'coordination-created';
  created.textContent = `${formatCreatedMonthDay(coordination.created_at)}作成`;
  metaRow.appendChild(created);

  // 範囲は閉じた状態でも見えるよう、バッジの左に出す（長い範囲は省略し、全文はtitleで出す）
  if (coordination.audience) {
    const audience = document.createElement('span');
    audience.className = 'coordination-audience-chip';
    audience.textContent = `範囲：${coordination.audience}`;
    audience.title = `参加できる人の範囲：${coordination.audience}`;
    metaRow.appendChild(audience);
  }

  if (coordination.is_blind) {
    const blindBadge = document.createElement('span');
    blindBadge.className = 'coordination-blind-badge';
    blindBadge.textContent = '🔒 限定';
    blindBadge.title = 'ブラインド（リンクを知っている人だけ）';
    metaRow.appendChild(blindBadge);
  }

  const badge = document.createElement('span');
  badge.className = coordination.status === 'decided' ? 'finished-badge' : 'coordination-status-open';
  badge.textContent = coordination.status === 'decided' ? '決定済み' : '調整中';
  metaRow.appendChild(badge);

  const chevron = document.createElement('span');
  chevron.className = 'coordination-card-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▼';
  metaRow.appendChild(chevron);

  summary.appendChild(metaRow);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'coordination-card-body';

  const meta = document.createElement('p');
  meta.className = 'coordination-meta';
  meta.textContent = `${coordination.branch} ・ 場所: ${coordination.place}`;
  body.appendChild(meta);

  if (coordination.is_blind) {
    const blindNote = document.createElement('p');
    blindNote.className = 'coordination-blind-note';
    blindNote.textContent =
      '🔒 ブラインド：一覧には、作成者・この支部を管理する管理者・回答した人にだけ表示されます。ほかの人にはリンクで伝えてください。';
    body.appendChild(blindNote);
  }

  if (coordination.audience) {
    const audience = document.createElement('p');
    audience.className = 'coordination-audience';
    audience.textContent = `参加できる人の範囲: ${coordination.audience}`;
    body.appendChild(audience);
  }

  const content = document.createElement('p');
  content.className = 'event-content';
  linkifyInto(content, coordination.content);
  body.appendChild(content);

  if (coordination.reply_deadline) {
    const deadline = document.createElement('p');
    deadline.className = 'coordination-deadline';
    deadline.textContent = `回答締切: ${formatDateWithWeekday(coordination.reply_deadline)}`;
    body.appendChild(deadline);
  }

  if (coordination.status === 'decided') {
    body.appendChild(createDecidedInfo(coordination));
  }

  body.appendChild(createVoteSection(coordination));
  body.appendChild(createShareActions(coordination));
  body.appendChild(createCardActions(coordination));

  // 削除は「回答する」から離し、カード右下に小さな文字リンクとして置く
  // （回答の取消と誤タップしないようにするため）。決定済みも削除できる（スケジュールの予定は残る）
  if (canManage(coordination)) {
    body.appendChild(createDeleteLink(coordination));
  }

  details.appendChild(body);
  card.appendChild(details);
  return card;
}

const createdMonthDayFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
});

// created_at（timestamptz）を日本時間の「M/D」にする
function formatCreatedMonthDay(createdAt) {
  const parts = createdMonthDayFormatter.formatToParts(new Date(createdAt));
  const month = parts.find((p) => p.type === 'month').value;
  const day = parts.find((p) => p.type === 'day').value;
  return `${month}/${day}`;
}

function createDeleteLink(coordination) {
  const wrap = document.createElement('div');
  wrap.className = 'coordination-delete-link-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'coordination-delete-link';
  btn.textContent = 'この日程調整を削除';
  btn.addEventListener('click', () => handleDeleteCoordination(coordination));

  wrap.appendChild(btn);
  return wrap;
}

// 決定情報の日時。決定ダイアログで入れた時刻（登録された予定の時刻）を表示する。
// 終了時刻があれば「10:00〜12:00」、なければ開始時刻だけ。
// 予定が取れない場合は、これまでどおり決定した候補の表示（時刻が空なら「終日」）に戻す
function decidedLabel(coordination) {
  const event = coordination.decided_event;
  if (event && event.date && event.time) {
    const start = event.time.slice(0, 5);
    const range = event.end_time ? `${start}〜${event.end_time.slice(0, 5)}` : start;
    return `${formatDateWithWeekday(event.date)}${range}`;
  }
  const candidate = decidedCandidateOf(coordination);
  return candidate ? formatCandidateLabel(candidate) : '';
}

function createDecidedInfo(coordination) {
  const box = document.createElement('div');
  box.className = 'coordination-decided-info';

  const label = decidedLabel(coordination);
  const text = document.createElement('p');
  text.className = 'coordination-decided-text';
  text.textContent = label ? `${label}に決定` : '決定済み';
  box.appendChild(text);

  // 決定した人（migration 0024 より前の決定・表示名が取れないときは出さない）
  const deciderName = coordination.decided_by_user_id ? state.userNames.get(coordination.decided_by_user_id) : null;
  if (deciderName) {
    const decider = document.createElement('p');
    decider.className = 'coordination-decided-by';
    decider.textContent = `${deciderName}さんが決定`;
    box.appendChild(decider);
  }

  if (coordination.decided_event_id) {
    // 決定で作られた予定を、スケジュール画面で直接開く（index.html?event=<id>）。
    // 予定が削除された場合はDBトリガーで調整中に戻る
    const link = document.createElement('a');
    link.href = `index.html?event=${encodeURIComponent(coordination.decided_event_id)}`;
    link.className = 'btn btn-outline btn-small';
    link.textContent = 'スケジュール画面で見る';
    box.appendChild(link);
    return box;
  }

  // スケジュールに載せなかった決定（migration 0024。予定が無い決定済み）
  const note = document.createElement('p');
  note.className = 'coordination-decided-by';
  note.textContent = 'スケジュールには載せていません';
  box.appendChild(note);
  // 取り消し（調整中に戻す）は、作成者本人か、その支部を管理する管理者だけ（決定と同じ判定）
  if (canManage(coordination)) {
    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'btn btn-outline btn-small';
    reopenBtn.textContent = '決定を取り消す';
    reopenBtn.addEventListener('click', () => handleReopenCoordination(coordination, reopenBtn));
    box.appendChild(reopenBtn);
  }
  return box;
}

async function handleReopenCoordination(coordination, button) {
  if (!confirm(`『${coordination.title}』の決定を取り消して、調整中に戻しますか？回答はそのまま残ります。`)) return;
  button.disabled = true;
  try {
    await api.reopenCoordination(coordination.id);
    state.accordionOpen.add(coordination.id);
    state.pendingScroll = { id: coordination.id, requireStatus: 'open' };
    await refreshList();
  } catch (err) {
    alert(err.message);
    button.disabled = false;
  }
}

function createShareActions(coordination) {
  return createCopyButtons({
    getChatworkText: () => buildChatworkText(coordination),
    getUrl: () => buildCoordinationUrl(coordination),
  });
}

function createCardActions(coordination) {
  const row = document.createElement('div');
  row.className = 'coordination-card-actions';

  if (coordination.status === 'open') {
    const answerBtn = document.createElement('button');
    answerBtn.type = 'button';
    answerBtn.className = 'btn btn-primary btn-small';
    answerBtn.textContent = '📝 回答する';
    answerBtn.addEventListener('click', () => openAnswerDialog(coordination, null));
    row.appendChild(answerBtn);

    // 編集は調整中のときだけ、作成者本人か、その支部を管理する管理者に出す（決定・削除と同じ判定）
    if (canManage(coordination)) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-outline btn-small';
      editBtn.textContent = '✏️ 編集';
      editBtn.addEventListener('click', () => openEditDialog(coordination));
      row.appendChild(editBtn);
    }
  }

  return row;
}

// ===================== 候補×回答者の表 =====================

// カード自体が開閉式のため、表は開閉せずにそのまま表示する（要約1行＋案内文＋表）
function createVoteSection(coordination) {
  const candidates = sortedCandidates(coordination);
  const responses = coordination.coordination_responses || [];

  const counts = new Map(); // candidate_id -> { yes, maybe, no }
  for (const c of candidates) counts.set(c.id, { yes: 0, maybe: 0, no: 0 });
  for (const r of responses) {
    for (const a of r.coordination_answers || []) {
      const bucket = counts.get(a.candidate_id);
      if (bucket) bucket[a.mark] += 1;
    }
  }
  let topCount = 0;
  for (const bucket of counts.values()) topCount = Math.max(topCount, bucket.yes);
  const topCandidateIds = new Set(
    topCount > 0 ? candidates.filter((c) => counts.get(c.id).yes === topCount).map((c) => c.id) : []
  );

  const section = document.createElement('div');
  section.className = 'coordination-vote-section';

  const summaryText = document.createElement('p');
  summaryText.className = 'coordination-vote-summary';
  const parts = [`候補${candidates.length}件`, `回答${responses.length}人`];
  if (topCount > 0) {
    const topLabel = candidates.filter((c) => topCandidateIds.has(c.id)).map((c) => formatCandidateLabel(c)).join('・');
    parts.push(`〇最多: ${topLabel}(${topCount}件)`);
  }
  summaryText.textContent = parts.join(' ・ ');
  section.appendChild(summaryText);

  if (candidates.length === 0) {
    section.appendChild(hintEl('候補がありません'));
  } else {
    // 回答が0件でも、候補があれば表（と決定行）は表示する。決定は回答が無くても行えるため
    if (responses.length === 0) section.appendChild(hintEl('まだ回答はありません'));
    // 案内文は「回答が1件以上あり、かつ調整中（タップで編集できる状態）」のときだけ出す
    if (responses.length > 0 && coordination.status === 'open') {
      const hint = document.createElement('p');
      hint.className = 'coordination-table-hint';
      hint.textContent = '名前をタップすると回答を編集できます';
      section.appendChild(hint);
    }
    section.appendChild(createVoteTable(coordination, candidates, responses, counts, topCandidateIds));
  }

  return section;
}

// 行＝候補日、列＝回答者。候補日・〇・△・✕の4列はCSS側でposition:stickyにして固定し、
// 回答者の列だけが横スクロールする（調整さんに近いレイアウト）
function createVoteTable(coordination, candidates, responses, counts, topCandidateIds) {
  const wrap = document.createElement('div');
  wrap.className = 'coordination-table-wrap';

  const table = document.createElement('table');
  table.className = 'coordination-table';
  const canDecide = canManage(coordination) && coordination.status === 'open';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(makeHeaderCell('候補日', 'coordination-col-date'));
  headRow.appendChild(makeHeaderCell('〇', 'coordination-col-count coordination-col-count-yes'));
  headRow.appendChild(makeHeaderCell('△', 'coordination-col-count coordination-col-count-maybe'));
  headRow.appendChild(makeHeaderCell('✕', 'coordination-col-count coordination-col-count-no'));
  for (const response of responses) {
    headRow.appendChild(createResponderHeaderCell(coordination, response));
  }
  if (canDecide) headRow.appendChild(makeHeaderCell('決定'));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const candidate of candidates) {
    tbody.appendChild(createCandidateRowInTable(coordination, candidate, responses, counts, topCandidateIds, canDecide));
  }
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

function makeHeaderCell(text, className) {
  const th = document.createElement('th');
  if (className) th.className = className;
  th.textContent = text;
  return th;
}

// 回答者の列見出し：名前・（代理登録表示）・コメント・編集/取消ボタンをまとめて縦に並べる
// （行が候補日になったため、回答者ごとの操作は「その人の列」の見出しに置く）
// 編集できる本人/代理登録者は、名前自体をタップして回答ダイアログを開く（調整さんに近い操作感）。
// 取消は編集ボタンを廃止した代わりに回答ダイアログ側へ移した（handleAnswerDialogDelete参照）
function createResponderHeaderCell(coordination, response) {
  const th = document.createElement('th');
  th.className = 'coordination-col-responder';

  const canEditThisRow = isMyResponseRow(coordination, response) && coordination.status === 'open';
  if (canEditThisRow) {
    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'coordination-responder-name-btn';
    nameBtn.textContent = response.participant_name;
    nameBtn.setAttribute('aria-label', `${response.participant_name}さんの回答を編集`);
    nameBtn.addEventListener('click', () => openAnswerDialog(coordination, response));
    th.appendChild(nameBtn);
  } else {
    const name = document.createElement('span');
    name.className = 'participant-name';
    name.textContent = response.participant_name;
    th.appendChild(name);
  }

  if (response.registered_by && response.registered_by !== response.participant_name) {
    const byline = document.createElement('span');
    byline.className = 'participant-registered-by';
    byline.textContent = `（${response.registered_by}さんが登録）`;
    th.appendChild(byline);
  }

  if (response.comment) {
    const comment = document.createElement('span');
    comment.className = 'coordination-response-comment';
    linkifyInto(comment, response.comment);
    th.appendChild(comment);
  }

  return th;
}

function createCandidateRowInTable(coordination, candidate, responses, counts, topCandidateIds, canDecide) {
  const tr = document.createElement('tr');
  if (topCandidateIds.has(candidate.id)) tr.classList.add('coordination-row-top');

  tr.appendChild(createCandidateDateCell(candidate));

  const bucket = counts.get(candidate.id);
  tr.appendChild(makeCountCell(bucket.yes, 'coordination-col-count coordination-col-count-yes'));
  tr.appendChild(makeCountCell(bucket.maybe, 'coordination-col-count coordination-col-count-maybe'));
  tr.appendChild(makeCountCell(bucket.no, 'coordination-col-count coordination-col-count-no'));

  for (const response of responses) {
    const mark = (response.coordination_answers || []).find((a) => a.candidate_id === candidate.id)?.mark;
    tr.appendChild(makeMarkCell(mark));
  }

  if (canDecide) {
    const td = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-outline btn-small';
    btn.textContent = '決定';
    btn.addEventListener('click', () => openDecideDialog(coordination, candidate));
    td.appendChild(btn);
    tr.appendChild(td);
  }

  return tr;
}

// 候補日×回答者の表の候補日セルのみ、日付と時刻を2段表示にする（列幅を詰めるため）
function createCandidateDateCell(candidate) {
  const td = document.createElement('td');
  td.className = 'coordination-col-date';

  const { dateLabel, secondLine } = candidateDateParts(candidate);
  const line1 = document.createElement('span');
  line1.className = 'coordination-col-date-line1';
  line1.textContent = dateLabel;
  const line2 = document.createElement('span');
  line2.className = 'coordination-col-date-line2';
  line2.textContent = secondLine;

  td.append(line1, line2);
  return td;
}

function makeCountCell(count, className) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = String(count);
  return td;
}

function makeMarkCell(mark) {
  const td = document.createElement('td');
  td.className = 'coordination-col-mark';
  const span = document.createElement('span');
  span.className = `coordination-mark ${mark ? `coordination-mark-${mark}` : 'coordination-mark-none'}`;
  // 回答がない候補（回答後に編集で追加された候補など）は「－」。読み上げと長押しでは「未回答」
  span.textContent = mark ? MARK_LABELS[mark] : '－';
  if (!mark) {
    span.title = '未回答';
    span.setAttribute('aria-label', '未回答');
  }
  td.appendChild(span);
  return td;
}

// ===================== 調整の作成 =====================

// 候補1行（日付・時刻・補足・削除）。作成フォームと編集ダイアログで共通。
// initial.id があれば既存の候補として data-candidate-id に持つ（編集時にAPIへidを付けて渡すため）
function createCandidateRow(initial = {}) {
  candidateRowSeq += 1;
  const row = document.createElement('div');
  row.className = 'coordination-candidate-row';
  row.dataset.rowId = String(candidateRowSeq);
  if (initial.id) row.dataset.candidateId = initial.id;

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'coordination-candidate-date';
  dateInput.required = true;
  dateInput.value = initial.date || '';

  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.className = 'coordination-candidate-time';
  // 時刻入力ではplaceholderが表示されないため、長押し・読み上げ用の説明として付ける
  // （画面上の説明は候補の一覧の上の「時刻は空欄でもOK…」の1行）
  timeInput.title = '時刻（空欄なら終日）';
  timeInput.setAttribute('aria-label', '時刻（空欄なら終日）');
  timeInput.value = initial.time ? initial.time.slice(0, 5) : '';

  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.className = 'coordination-candidate-note';
  noteInput.placeholder = '午前・撮影日 など';
  noteInput.maxLength = CANDIDATE_NOTE_MAX; // DB側のCHECK制約(50文字)と合わせる
  noteInput.value = initial.note || '';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-muted btn-small';
  removeBtn.textContent = '削除';
  removeBtn.addEventListener('click', () => {
    if (row.parentElement && row.parentElement.children.length <= 1) return; // 最低1件は残す
    row.remove();
  });

  row.append(dateInput, timeInput, noteInput, removeBtn);
  return row;
}

// 候補の行を読み取る（作成フォームと編集ダイアログで共通）。既存の候補にはidが付く
function readCandidateRows(listEl) {
  return [...listEl.querySelectorAll('.coordination-candidate-row')].map((row) => {
    const candidate = {
      date: row.querySelector('.coordination-candidate-date').value,
      time: row.querySelector('.coordination-candidate-time').value || undefined,
      note: row.querySelector('.coordination-candidate-note').value.trim() || undefined,
    };
    if (row.dataset.candidateId) candidate.id = row.dataset.candidateId;
    return candidate;
  });
}

// 日付が入っている候補を「日付|時刻」でまとめて数え、2つ以上あるか
// （補足だけ違う同じ日時は1件。API側と同じ数え方。作成と編集で共通）
function hasEnoughCandidates(candidates) {
  const uniqueKeys = new Set(
    candidates.filter((c) => c.date).map((c) => `${c.date}|${c.time ? c.time.slice(0, 5) : ''}`)
  );
  return uniqueKeys.size >= MIN_CANDIDATES;
}

function resetCoordinationForm() {
  els.coordinationForm.reset();
  state.createAudiencePicker.reset();
  state.createAudiencePicker.setChoices(state.audienceOptions, null);
  els.coordinationCandidatesList.innerHTML = '';
  els.coordinationCandidatesList.appendChild(createCandidateRow());
  els.coordinationCandidatesList.appendChild(createCandidateRow());
  els.coordinationCreatedBy.textContent = state.myName;
  els.coordinationFormError.textContent = '';
}

function bindCoordinationForm() {
  els.coordinationAddCandidateBtn.addEventListener('click', () => {
    els.coordinationCandidatesList.appendChild(createCandidateRow());
  });
  els.coordinationForm.addEventListener('submit', handleCreateCoordination);
}

async function handleCreateCoordination(event) {
  event.preventDefault();
  els.coordinationFormError.textContent = '';

  if (!state.branch) {
    els.coordinationFormError.textContent = '支部を選択してください';
    return;
  }

  const candidates = readCandidateRows(els.coordinationCandidatesList);
  if (!hasEnoughCandidates(candidates)) {
    els.coordinationFormError.textContent = MIN_CANDIDATES_MESSAGE;
    return;
  }

  const submitBtn = els.coordinationForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const created = await api.createCoordination({
      branch: state.branch,
      title: els.coordinationTitle.value.trim(),
      place: els.coordinationPlace.value.trim(),
      content: els.coordinationContent.value.trim(),
      reply_deadline: els.coordinationDeadline.value || undefined,
      audience: state.createAudiencePicker.getValue(), // 空なら範囲なし
      is_blind: els.coordinationBlind.checked,
      candidates,
    });
    loadAudienceOptions(); // 新しく入力した範囲は候補に入るため読み直す
    els.coordinationForm.classList.add('hidden');
    els.newCoordinationToggleBtn.textContent = '＋ 日程調整を作成';
    // 作成した本人の画面だけ、作った調整を開いた状態で表示する
    if (created && created.id) {
      state.accordionOpen.add(created.id);
      state.pendingScroll = { id: created.id, requireStatus: null };
    }
    await refreshList();
  } catch (err) {
    els.coordinationFormError.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleDeleteCoordination(coordination) {
  const responseCount = (coordination.coordination_responses || []).length;
  const eventNote = coordination.status === 'decided' ? 'スケジュールの予定は残ります。' : '';
  const message = `日程調整『${coordination.title}』を削除します。回答${responseCount}人分もすべて消え、元に戻せません。${eventNote}よろしいですか？`;
  if (!confirm(message)) return;
  try {
    await api.deleteCoordination(coordination.id, {});
    state.accordionOpen.delete(coordination.id);
    await refreshList();
  } catch (err) {
    alert(err.message);
  }
}

// ===================== 回答ダイアログ =====================

function bindAnswerDialog() {
  els.answerCancel.addEventListener('click', () => els.answerDialog.close());
  els.answerDelete.addEventListener('click', handleAnswerDialogDelete);
  els.answerComment.addEventListener('input', updateAnswerCommentCount);
  els.answerName.addEventListener('input', updateAnswerProxyNote);
  els.answerForm.addEventListener('submit', handleAnswerSubmit);
}

function updateAnswerCommentCount() {
  const remaining = Math.max(0, COMMENT_MAX - els.answerComment.value.length);
  els.answerCommentCount.textContent = `残り${remaining}文字`;
}

function updateAnswerProxyNote() {
  const name = els.answerName.value.trim();
  const isProxy = Boolean(name) && name !== state.myName;
  els.answerProxyNote.classList.toggle('hidden', !isProxy);
  els.answerProxyNote.textContent = isProxy ? `代理登録になります（登録者: ${state.myName}）` : '';
}

function openAnswerDialog(coordination, editingResponse) {
  const candidates = sortedCandidates(coordination);
  answerDialogCtx = { coordinationId: coordination.id, coordination, editingResponse };

  els.answerDialogTitle.textContent = editingResponse ? '回答を編集' : '回答する';
  els.answerAudience.textContent = coordination.audience ? `参加できる人の範囲：${coordination.audience}` : '';
  els.answerAudience.classList.toggle('hidden', !coordination.audience);
  els.answerName.value = editingResponse ? editingResponse.participant_name : state.myName;
  els.answerName.readOnly = Boolean(editingResponse);
  els.answerComment.value = editingResponse?.comment || '';
  updateAnswerCommentCount();
  updateAnswerProxyNote();
  els.answerError.textContent = '';
  // 取消は既存の回答を編集しているときだけ出す（新規回答のときは出さない）
  els.answerDelete.classList.toggle('hidden', !editingResponse);

  const answerByCandidate = new Map((editingResponse?.coordination_answers || []).map((a) => [a.candidate_id, a.mark]));
  els.answerCandidatesList.innerHTML = '';
  for (const candidate of candidates) {
    els.answerCandidatesList.appendChild(createAnswerCandidateRow(candidate, answerByCandidate.get(candidate.id)));
  }

  els.answerDialog.showModal();
}

function createAnswerCandidateRow(candidate, currentMark) {
  const row = document.createElement('div');
  row.className = 'coordination-answer-candidate-row';

  const label = document.createElement('span');
  label.className = 'coordination-answer-candidate-label';
  label.textContent = formatCandidateLabel(candidate);
  row.appendChild(label);

  const radios = document.createElement('span');
  radios.className = 'coordination-answer-candidate-marks';
  const radioLabels = [];
  for (const mark of ['yes', 'maybe', 'no']) {
    const radioLabel = document.createElement('label');
    radioLabel.className = `coordination-mark-radio-label coordination-mark-radio-label-${mark}`;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.className = 'coordination-mark-radio-input';
    radio.name = `answer-mark-${candidate.id}`;
    radio.value = mark;
    radio.dataset.candidateId = candidate.id;
    radio.checked = currentMark === mark;
    // 記号(span)はaria-hiddenのため、読み上げ用の名前はここで明示する
    radio.setAttribute('aria-label', MARK_ARIA_LABELS[mark]);
    // 見た目は記号ボタンだが中身はradioのまま。キーボードのTab/矢印キー・スクリーンリーダーでの
    // 選択操作はネイティブのradio挙動に任せ、選択状態の見た目だけJSでクラスを付け替える
    radio.addEventListener('change', () => {
      for (const otherLabel of radioLabels) {
        otherLabel.classList.toggle('is-checked', otherLabel.querySelector('input').checked);
      }
    });

    const symbol = document.createElement('span');
    symbol.className = 'coordination-mark-radio-symbol';
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = MARK_LABELS[mark];

    radioLabel.append(radio, symbol);
    radioLabel.classList.toggle('is-checked', radio.checked);
    radioLabels.push(radioLabel);
    radios.appendChild(radioLabel);
  }
  row.appendChild(radios);
  return row;
}

async function handleAnswerSubmit(event) {
  event.preventDefault();
  els.answerError.textContent = '';

  const name = els.answerName.value.trim();
  if (!name) {
    els.answerError.textContent = 'お名前を入力してください';
    return;
  }
  const comment = els.answerComment.value.trim();
  if ([...comment].length > COMMENT_MAX) {
    els.answerError.textContent = `コメントは${COMMENT_MAX}文字以内で入力してください`;
    return;
  }

  const answers = [];
  const radios = els.answerCandidatesList.querySelectorAll('input[type="radio"]');
  const byCandidate = new Map();
  for (const radio of radios) {
    if (radio.checked) byCandidate.set(radio.dataset.candidateId, radio.value);
  }
  const candidateIds = new Set([...radios].map((r) => r.dataset.candidateId));
  for (const candidateId of candidateIds) {
    if (!byCandidate.has(candidateId)) {
      els.answerError.textContent = 'すべての候補に回答してください';
      return;
    }
    answers.push({ candidate_id: candidateId, mark: byCandidate.get(candidateId) });
  }

  els.answerSubmit.disabled = true;
  try {
    await api.submitResponse({
      coordination_id: answerDialogCtx.coordinationId,
      participant_name: name,
      comment,
      answers,
      token: answerDialogCtx.coordination.share_token || undefined, // ブラインドの調整は、トークンを知っている人も回答できる
    });
    els.answerDialog.close();
    await refreshList();
  } catch (err) {
    els.answerError.textContent = err.message;
  } finally {
    els.answerSubmit.disabled = false;
  }
}

// 回答ダイアログ内の「取消」。既存の回答を編集しているときだけ表示され、確認の上で取り消す
async function handleAnswerDialogDelete() {
  if (!answerDialogCtx?.editingResponse) return;
  const { coordination, editingResponse } = answerDialogCtx;
  if (!confirm('回答を取り消しますか？')) return;

  els.answerDelete.disabled = true;
  try {
    await api.deleteResponse({
      coordination_id: coordination.id,
      participant_name: editingResponse.participant_name,
      token: coordination.share_token || undefined,
    });
    els.answerDialog.close();
    await refreshList();
  } catch (err) {
    els.answerError.textContent = err.message;
  } finally {
    els.answerDelete.disabled = false;
  }
}

// ===================== 決定ダイアログ =====================

function bindDecideDialog() {
  els.decideCancel.addEventListener('click', () => els.decideDialog.close());
  els.decideScheduleYes.addEventListener('change', updateDecideScheduleView);
  els.decideScheduleNo.addEventListener('change', updateDecideScheduleView);
  els.decideForm.addEventListener('submit', handleDecideSubmit);
}

// 「スケジュールに載せる／載せない」に合わせて、予定の内容の欄を出し入れする。
// 載せないときは欄の枠（fieldset）ごと disabled にして、隠れた必須の欄でフォームが送れなくならないようにする
function updateDecideScheduleView() {
  const addToSchedule = els.decideScheduleYes.checked;
  els.decideScheduleFields.disabled = !addToSchedule;
  els.decideScheduleFields.classList.toggle('hidden', !addToSchedule);

  let note = '';
  if (!addToSchedule) {
    note = '予定も参加者の登録も作らず、この日程調整の中だけで決定済みにします。あとで「決定を取り消す」で調整中に戻せます。';
  } else if (decideDialogCtx?.isBlind) {
    note = 'スケジュールの予定は、ブラインドの日程調整でも、誰でも見られます。';
  }
  els.decideScheduleNote.textContent = note;
  els.decideScheduleNote.classList.toggle('hidden', !note);
}

// ===================== 編集ダイアログ =====================

function bindEditDialog() {
  els.editCancel.addEventListener('click', () => els.editDialog.close());
  els.editAddCandidateBtn.addEventListener('click', () => {
    els.editCandidatesList.appendChild(createCandidateRow());
  });
  els.editForm.addEventListener('submit', handleEditSubmit);
}

function openEditDialog(coordination) {
  editDialogCtx = { coordinationId: coordination.id };

  els.editTitle.value = coordination.title;
  els.editPlace.value = coordination.place;
  els.editContent.value = coordination.content;
  els.editDeadline.value = coordination.reply_deadline || '';
  // 今の範囲が候補に無くても「〇〇（今の範囲）」として選んだ状態で出す（そのまま保存しても変わらない）
  state.editAudiencePicker.reset();
  state.editAudiencePicker.setChoices(state.audienceOptions, coordination.audience || null);
  els.editBlind.checked = Boolean(coordination.is_blind);
  els.editCandidatesList.innerHTML = '';
  for (const candidate of sortedCandidates(coordination)) {
    els.editCandidatesList.appendChild(createCandidateRow(candidate));
  }
  els.editError.textContent = '';

  els.editDialog.showModal();
}

// 保存したときに消える回答を、最新のデータから数える。
//   ・送られなかった既存の候補 → 削除（回答が消える）
//   ・日付か時刻が変わった候補 → 作り直し（回答が消える）。補足だけの変更なら回答は残る
// 戻り値: 消える回答がある候補ごとの説明文の配列（無ければ空）
function describeLostAnswers(latest, submitted) {
  const submittedById = new Map(submitted.filter((c) => c.id).map((c) => [c.id, c]));
  const lines = [];
  for (const candidate of sortedCandidates(latest)) {
    const counts = { yes: 0, maybe: 0, no: 0 };
    for (const response of latest.coordination_responses || []) {
      const answer = (response.coordination_answers || []).find((a) => a.candidate_id === candidate.id);
      if (answer) counts[answer.mark] += 1;
    }
    if (counts.yes + counts.maybe + counts.no === 0) continue;
    const countText = `〇${counts.yes}人・△${counts.maybe}人・✕${counts.no}人`;

    const next = submittedById.get(candidate.id);
    if (!next) {
      lines.push(`・${formatCandidateLabel(candidate)}を削除：この候補への回答（${countText}）も消えます`);
      continue;
    }
    const oldTime = candidate.time ? candidate.time.slice(0, 5) : '';
    const newTime = next.time ? next.time.slice(0, 5) : '';
    if (candidate.date !== next.date || oldTime !== newTime) {
      const nextLabel = formatCandidateLabel({ date: next.date, time: next.time || null, note: next.note || null });
      lines.push(
        `・${formatCandidateLabel(candidate)} を ${nextLabel} に変更：この候補への回答（${countText}）も消えます`
      );
    }
  }
  return lines;
}

async function handleEditSubmit(event) {
  event.preventDefault();
  els.editError.textContent = '';
  if (!editDialogCtx) return;

  const candidates = readCandidateRows(els.editCandidatesList);
  if (!hasEnoughCandidates(candidates)) {
    els.editError.textContent = MIN_CANDIDATES_MESSAGE;
    return;
  }

  els.editSubmit.disabled = true;
  try {
    // 編集画面を開いている間に回答が増えている場合もあるため、確認の前に最新のデータを取り直す
    // （ブラインドの調整は anon から見えないため、API から取る）
    let latest;
    try {
      latest = await fetchCoordinationById(editDialogCtx.coordinationId);
    } catch (err) {
      console.error(err);
      els.editError.textContent = '最新の内容を取得できませんでした。時間をおいて再度お試しください';
      return;
    }
    if (!latest) {
      els.editError.textContent = 'この日程調整は見つかりませんでした（削除された可能性があります）';
      return;
    }
    if (latest.status !== 'open') {
      els.editError.textContent = '決定済みの日程調整は編集できません';
      return;
    }

    const lines = describeLostAnswers(latest, candidates);
    if (lines.length > 0 && !confirm(`次の候補への回答が消えます。よろしいですか？\n${lines.join('\n')}`)) {
      return; // キャンセルならダイアログは開いたまま
    }

    await api.updateCoordination(editDialogCtx.coordinationId, {
      title: els.editTitle.value.trim(),
      place: els.editPlace.value.trim(),
      content: els.editContent.value.trim(),
      reply_deadline: els.editDeadline.value || undefined,
      audience: state.editAudiencePicker.getValue(), // 空なら範囲なし
      is_blind: els.editBlind.checked, // 通常⇔ブラインドの切り替え（リンクのトークンは変わらない）
      candidates,
    });
    loadAudienceOptions(); // 範囲を変えた場合は候補に入るため読み直す
    state.accordionOpen.add(editDialogCtx.coordinationId);
    els.editDialog.close();
    await refreshList();
  } catch (err) {
    els.editError.textContent = err.message; // 409（決定済み・ほかの人の編集と衝突）を含め、APIの日本語メッセージをそのまま表示
  } finally {
    els.editSubmit.disabled = false;
  }
}

function openDecideDialog(coordination, candidate) {
  decideDialogCtx = { coordinationId: coordination.id, candidateId: candidate.id, isBlind: Boolean(coordination.is_blind) };

  // スケジュールに載せるかの初期値: 通常の調整＝載せる、ブラインド＝載せない
  els.decideScheduleYes.checked = !coordination.is_blind;
  els.decideScheduleNo.checked = Boolean(coordination.is_blind);

  els.decideTime.value = candidate.time ? candidate.time.slice(0, 5) : '';
  els.decideEndTime.value = '';
  els.decidePlace.value = coordination.place;
  // 内容欄の初期値は「1行目: 調整のタイトル、2行目以降: 調整の内容」にする
  // （eventsにはタイトル列が無いため）。あくまで初期値で、その場で編集・削除できる。
  // 内容が空のときは余計な空行を残さずタイトルだけにする
  els.decideContent.value = coordination.content
    ? `${coordination.title}\n${coordination.content}`
    : coordination.title;
  els.decideCategorySelect.value = '';
  els.decideCategoryOtherWrap.classList.add('hidden');
  els.decideCategoryOther.value = '';
  els.decideDecidedBy.textContent = state.myName;
  els.decideRegisterYes.checked = true;
  els.decideRegisterMaybe.checked = false;
  els.decideError.textContent = '';
  updateDecideScheduleView();

  els.decideDialog.showModal();
}

async function handleDecideSubmit(event) {
  event.preventDefault();
  els.decideError.textContent = '';

  // スケジュールに載せないときは、予定の内容を送らない（予定も参加者も作らない）
  if (!els.decideScheduleYes.checked) {
    await submitDecide({ candidate_id: decideDialogCtx.candidateId, add_to_schedule: false });
    return;
  }

  const place = els.decidePlace.value.trim();
  const content = els.decideContent.value.trim();
  if (!place || !content) {
    els.decideError.textContent = '場所と活動内容を入力してください';
    return;
  }
  const time = els.decideTime.value;
  if (!time) {
    els.decideError.textContent = '開始時刻を入力してください';
    return;
  }
  const endTime = els.decideEndTime.value;
  if (endTime && endTime <= time) {
    els.decideError.textContent = '終了時間は開始時間より後にしてください';
    return;
  }
  const category =
    els.decideCategorySelect.value === OTHER_CATEGORY
      ? els.decideCategoryOther.value.trim()
      : els.decideCategorySelect.value;

  await submitDecide({
    candidate_id: decideDialogCtx.candidateId,
    add_to_schedule: true,
    place,
    content,
    category: category || undefined,
    time,
    end_time: endTime || undefined,
    register_yes: els.decideRegisterYes.checked,
    register_maybe: els.decideRegisterMaybe.checked,
  });
}

async function submitDecide(payload) {
  els.decideSubmit.disabled = true;
  try {
    await api.decideCoordination(decideDialogCtx.coordinationId, payload);
    els.decideDialog.close();
    // 決定済みは一覧の下へ移動するため、決定した本人の画面だけ、そのカードを開いたままスクロールで追いかける
    state.accordionOpen.add(decideDialogCtx.coordinationId);
    state.pendingScroll = { id: decideDialogCtx.coordinationId, requireStatus: 'decided' };
    await refreshList();
  } catch (err) {
    els.decideError.textContent = err.message; // 409を含め、APIの日本語メッセージをそのまま表示
  } finally {
    els.decideSubmit.disabled = false;
  }
}
