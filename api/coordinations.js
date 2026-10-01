const { getSupabaseClient } = require('./_lib/supabase');
const { resolveActor } = require('./_lib/auth');
const { regionResolverFor, canActOnRow, writerName, writerId } = require('./_lib/permissions');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES } = require('./_lib/branches');
const { addBranchOption } = require('./_lib/branchOptions');
const {
  COORDINATION_SELECT,
  respondedCoordinationIds,
  canViewCoordination,
  coordinationIdByToken,
  shareTokensFor,
} = require('./_lib/coordinationAccess');

const MAX_CANDIDATES = 30;
// 候補日の最低件数と、その不足時の文言（js/coordination.js の MIN_CANDIDATES / 文言と完全に一致させること）
const MIN_CANDIDATES = 2;
const MIN_CANDIDATES_MESSAGE =
  '日程調整は候補日を2つ以上入れてください。日にちが決まっている場合は、スケジュール画面から予定として登録してください。';
const CANDIDATE_NOTE_MAX_LENGTH = 50;
const CATEGORY_MAX_LENGTH = 50;
// 参加できる人の範囲（任意。migration 0022 の coordinations_audience_check と同じ上限）
const AUDIENCE_MAX_LENGTH = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 「日程調整で決まった予定」で返す件数の上限（これからの予定・終わった予定）。上限を超えた分は件数だけ返す
const MY_PLANS_UPCOMING_MAX = 50;
const MY_PLANS_PAST_MAX = 20;
// 日本時間の今日（YYYY-MM-DD）。js/coordination.js の todayInTokyo と同じ考え方
const tokyoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Vercel Hobbyプランのサーバーレス関数数上限（12個）を超えないよう、
// 元は3ファイルだった以下のエンドポイントをこの1ファイルにまとめている。
// 「/:id」「/:id/decide」というパス区切りの代わりに、クエリ文字列(?id=&action=)で分岐する。
//   GET    /api/coordinations?branch=xxx           : その支部のブラインドの調整のうち、見てよい人に当たるもの（migration 0023）
//   GET    /api/coordinations?token=xxx            : トークンの調整1件（coordination.html?t= のリンク用）
//   GET    /api/coordinations?id=xxx               : 1件（通常の調整か、見てよい人のときだけ）
//   GET    /api/coordinations?view=my_plans        : 日程調整で決まった予定（自分が〇△で回答して決定済みになった調整。全支部分）
//   POST   /api/coordinations                     : 新規作成（旧 api/coordinations.js）
//   PUT    /api/coordinations?id=xxx               : 編集（調整中のときだけ。DB関数update_coordination）
//   DELETE /api/coordinations?id=xxx               : 削除（旧 api/coordinations/[id].js）
//   POST   /api/coordinations?id=xxx&action=decide : 決定（旧 api/coordinations/[id]/decide.js）
//   POST   /api/coordinations?id=xxx&action=reopen : スケジュールに載せなかった決定の取り消し（調整中に戻す。migration 0024）
// 通常の調整の一覧・専用URL（?id=）の取得は、今までどおり js/coordination.js が anon key で直接Supabaseをselectする。
// ブラインドの調整は RLS で anon から見えないため、上の GET で返す（判定は api/_lib/coordinationAccess.js）。

// 生のDBエラーをクライアントに返さないための日本語メッセージ変換（作成・削除用）
function coordinationErrorResponse(error) {
  if (error.code === '22007' || error.code === '22008') {
    return { status: 400, message: '日付または時刻の形式が正しくありません' };
  }
  if (error.code === '23505') {
    return { status: 400, message: '同じ日時の候補が重複しています' };
  }
  console.error('coordinations write failed:', error);
  return { status: 500, message: '日程調整の作成に失敗しました。時間をおいて再度お試しください' };
}

// DB関数decide_coordinationが投げる想定内のエラー（P0001〜P0003）を日本語のまま伝える。
// それ以外（想定外のDBエラー）は汎用メッセージにする
function decideErrorResponse(error) {
  if (error.code === 'P0001') {
    return { status: 409, message: error.message };
  }
  if (error.code === 'P0002' || error.code === 'P0003') {
    return { status: 400, message: error.message };
  }
  if (error.code === '22007' || error.code === '22008') {
    return { status: 400, message: '時刻の形式が正しくありません' };
  }
  console.error('decide_coordination failed:', error);
  return { status: 500, message: '決定処理に失敗しました。時間をおいて再度お試しください' };
}

// DB関数update_coordinationが投げる想定内のエラーを日本語のまま伝える。
//   P0001: 決定済み・見つからない（409）／P0003: 入力の不備（400）／P0004: ほかの人の編集と衝突（409）
function updateErrorResponse(error) {
  if (error.code === 'P0001' || error.code === 'P0004') {
    return { status: 409, message: error.message };
  }
  if (error.code === 'P0003') {
    return { status: 400, message: error.message };
  }
  if (error.code === '22007' || error.code === '22008') {
    return { status: 400, message: '日付または時刻の形式が正しくありません' };
  }
  if (error.code === '22P02') {
    return { status: 400, message: '入力内容の形式が正しくありません' };
  }
  console.error('update_coordination failed:', error);
  return { status: 500, message: '日程調整の保存に失敗しました。時間をおいて再度お試しください' };
}

// 日程調整に対して、作成者本人（またはその支部を管理できる管理者）として操作できるか。
// 作成者のユーザーIDが空欄の調整（移行前）は、その支部を管理できる管理者だけ
async function canActOnCoordination(actor, existing) {
  const regionOf = await regionResolverFor(actor);
  return canActOnRow(actor, { branch: existing.branch, userIds: [existing.created_by_user_id] }, regionOf);
}

module.exports = async (req, res) => {
  const { id, action } = req.query;

  if (req.method === 'GET') {
    return handleGet(req, res);
  }
  if (req.method === 'POST' && !id) {
    return handleCreate(req, res);
  }
  if (req.method === 'POST' && id && action === 'decide') {
    return handleDecide(req, res, id);
  }
  if (req.method === 'POST' && id && action === 'reopen') {
    return handleReopen(req, res, id);
  }
  if (req.method === 'PUT' && id) {
    return handleUpdate(req, res, id);
  }
  if (req.method === 'DELETE' && id) {
    return handleDelete(req, res, id);
  }
  return methodNotAllowed(res, ['GET', 'POST', 'PUT', 'DELETE']);
};

// ブラインドの調整に、リンク用のトークン（share_token）を付ける。通常の調整には付けない（リンクは ?id= のまま）
async function withShareTokens(supabase, coordinations) {
  const blindIds = coordinations.filter((c) => c.is_blind).map((c) => c.id);
  const tokens = await shareTokensFor(supabase, blindIds);
  return coordinations.map((c) => (c.is_blind ? { ...c, share_token: tokens.get(c.id) || null } : c));
}

async function fetchCoordination(supabase, id) {
  const { data, error } = await supabase.from('coordinations').select(COORDINATION_SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// GET /api/coordinations : 日程調整の取得（ログインが必要）。どれも画面と同じ形（COORDINATION_SELECT）で返す
//   ?token=xxx  … トークンの調整1件（通常・ブラインドどちらも）。トークンが正しくなければ404
//   ?id=xxx     … 1件。ブラインドは見てよい人のときだけ。それ以外は404（ブラインドの調整があることも伝えない）
//   ?branch=xxx … その支部のブラインドの調整のうち、見てよい人に当たるもの（作成日時の新しい順）。
//                 通常の調整は返さない（画面が anon で直接読むため）
//   見てよい人: 作成者本人・その支部を管理できる管理者（システム管理者・自県連の県連管理者）・回答した人（代理登録を含む）
async function handleGet(req, res) {
  const { branch, token, id, view } = req.query;
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  const supabase = getSupabaseClient();

  try {
    if (view !== undefined) {
      if (view !== 'my_plans') {
        return sendJson(res, 400, { error: 'viewの指定が正しくありません' });
      }
      return sendJson(res, 200, await loadMyPlans(supabase, actor.user.id));
    }

    if (token !== undefined) {
      const coordinationId = await coordinationIdByToken(supabase, token);
      const coordination = coordinationId ? await fetchCoordination(supabase, coordinationId) : null;
      if (!coordination) {
        return sendJson(res, 404, { error: '日程調整が見つかりません' });
      }
      const [withToken] = await withShareTokens(supabase, [coordination]);
      return sendJson(res, 200, withToken);
    }

    if (id !== undefined) {
      if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
        return sendJson(res, 400, { error: 'IDの形式が正しくありません' });
      }
      const coordination = await fetchCoordination(supabase, id);
      if (!coordination) {
        return sendJson(res, 404, { error: '日程調整が見つかりません' });
      }
      if (coordination.is_blind) {
        const regionOf = await regionResolverFor(actor);
        const responded = await respondedCoordinationIds(supabase, actor.user.id, [coordination.id]);
        if (!canViewCoordination(actor, coordination, regionOf, responded)) {
          return sendJson(res, 404, { error: '日程調整が見つかりません' });
        }
      }
      const [withToken] = await withShareTokens(supabase, [coordination]);
      return sendJson(res, 200, withToken);
    }

    if (!BRANCHES.includes(branch)) {
      return sendJson(res, 400, { error: '支部が不正です' });
    }
    const { data, error } = await supabase
      .from('coordinations')
      .select(COORDINATION_SELECT)
      .eq('branch', branch)
      .eq('is_blind', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const blind = data || [];
    const regionOf = await regionResolverFor(actor);
    const responded = await respondedCoordinationIds(supabase, actor.user.id, blind.map((c) => c.id));
    const visible = blind.filter((c) => canViewCoordination(actor, c, regionOf, responded));
    return sendJson(res, 200, await withShareTokens(supabase, visible));
  } catch (err) {
    console.error('coordinations GET failed:', err);
    return sendJson(res, 500, { error: '日程調整の取得に失敗しました。時間をおいて再度お試しください' });
  }
}

// GET ?view=my_plans : 日程調整で決まった予定（本人の分だけ。全支部・通常とブラインド・載せる／載せないの区別なし）
//   対象: 本人の回答（participant_user_id が自分。代理登録した回答・移行前の名前だけの回答は含めない）がある、
//         決定済みの調整のうち、決定した候補に〇（yes）か△（maybe）と答えたもの
//   日付・時刻: スケジュールに載せた決定は予定（events）の日付・時刻（スケジュール画面で動かした場合も合わせる）、
//               載せなかった決定は決定した候補の日付・時刻（時刻が空なら終日）
//   返り値: { upcoming, upcoming_total, past, past_total }
//     upcoming … 今日（日本時間）以降。日付・時刻の早い順。最大 MY_PLANS_UPCOMING_MAX 件
//     past     … 今日より前（終わった予定）。新しい順。最大 MY_PLANS_PAST_MAX 件
//     1件: { id, title, branch, place, is_blind, mark, date, time, end_time, note, event_id, share_token }
//       event_id はスケジュールに載せたときだけ、share_token はブラインドのときだけ入る（本人は回答しているので見てよい人）。
//       ほかの人の回答や名前は返さない
async function loadMyPlans(supabase, userId) {
  const empty = { upcoming: [], upcoming_total: 0, past: [], past_total: 0 };
  const ids = [...(await respondedCoordinationIds(supabase, userId, null, { participantOnly: true }))];
  if (ids.length === 0) return empty;

  const { data, error } = await supabase
    .from('coordinations')
    .select(
      'id, branch, title, place, is_blind, decided_candidate_id, decided_event_id, ' +
        'coordination_candidates!coordination_candidates_coordination_id_fkey(id, date, time, note), ' +
        'coordination_responses(participant_user_id, coordination_answers(candidate_id, mark)), ' +
        'decided_event:events!coordinations_decided_event_id_fkey(date, time, end_time)'
    )
    .in('id', ids)
    .eq('status', 'decided');
  if (error) throw error;

  const plans = [];
  for (const c of data || []) {
    // 本人の回答（表示名を変えた人は2行あることがあるため、〇があれば〇、なければ△）
    const marks = (c.coordination_responses || [])
      .filter((r) => r.participant_user_id === userId)
      .flatMap((r) => r.coordination_answers || [])
      .filter((a) => a.candidate_id === c.decided_candidate_id)
      .map((a) => a.mark);
    const mark = marks.includes('yes') ? 'yes' : marks.includes('maybe') ? 'maybe' : null;
    if (!mark) continue;

    const candidate = (c.coordination_candidates || []).find((x) => x.id === c.decided_candidate_id);
    const event = c.decided_event_id ? c.decided_event : null;
    const date = event ? event.date : candidate && candidate.date;
    if (!date) continue; // 決定した候補が見つからない（通常は起きない）
    plans.push({
      id: c.id,
      title: c.title,
      branch: c.branch,
      place: c.place,
      is_blind: c.is_blind,
      mark,
      date,
      time: event ? event.time : (candidate && candidate.time) || null,
      end_time: event ? event.end_time : null,
      note: event ? null : (candidate && candidate.note) || null,
      event_id: c.decided_event_id || null,
    });
  }

  const today = tokyoDateFormatter.format(new Date());
  const key = (p) => `${p.date} ${p.time || ''}`;
  const upcomingAll = plans.filter((p) => p.date >= today).sort((a, b) => key(a).localeCompare(key(b)));
  const pastAll = plans.filter((p) => p.date < today).sort((a, b) => key(b).localeCompare(key(a)));
  const upcoming = upcomingAll.slice(0, MY_PLANS_UPCOMING_MAX);
  const past = pastAll.slice(0, MY_PLANS_PAST_MAX);

  // ブラインドの調整には、開くためのトークンを付ける
  const tokens = await shareTokensFor(
    supabase,
    [...upcoming, ...past].filter((p) => p.is_blind).map((p) => p.id)
  );
  const withToken = (p) => ({ ...p, share_token: p.is_blind ? tokens.get(p.id) || null : null });
  return {
    upcoming: upcoming.map(withToken),
    upcoming_total: upcomingAll.length,
    past: past.map(withToken),
    past_total: pastAll.length,
  };
}

// ブラインドの指定の入力チェック（作成と編集で共通）。
// 返り値: { value }（true/false）か { error }。送られていない（undefined）ときは { keep: true }
function parseIsBlind(isBlind) {
  if (isBlind === undefined) return { keep: true };
  if (typeof isBlind !== 'boolean') return { error: 'ブラインドの指定が正しくありません' };
  return { value: isBlind };
}

// 題名・場所・内容・回答締切の入力チェック（作成と編集で共通）
function validateCoordinationFields({ title, place, content, reply_deadline }) {
  const trimmedTitle = typeof title === 'string' ? title.trim() : '';
  const trimmedPlace = typeof place === 'string' ? place.trim() : '';
  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  if (!trimmedTitle || !trimmedPlace || !trimmedContent) {
    return { error: '必須項目が不足しています' };
  }
  const trimmedDeadline = typeof reply_deadline === 'string' ? reply_deadline.trim() : '';
  return { trimmedTitle, trimmedPlace, trimmedContent, trimmedDeadline };
}

// 範囲の入力チェック（作成と編集で共通）。前後の空白を除いて50文字以内、空なら null（範囲なし）。
// 返り値: { value } か { error }。audience が送られていない（undefined）ときは { keep: true }
// （編集では今の値をそのまま残す。範囲の欄が無い古い画面から保存しても、範囲が消えないようにするため）
function parseAudience(audience) {
  if (audience === undefined) return { keep: true };
  if (audience !== null && typeof audience !== 'string') {
    return { error: '範囲の形式が正しくありません' };
  }
  const value = (audience || '').trim();
  if ([...value].length > AUDIENCE_MAX_LENGTH) {
    return { error: `範囲は${AUDIENCE_MAX_LENGTH}文字以内で入力してください` };
  }
  return { value: value || null };
}

// 候補日時の入力チェック（作成と編集で共通）。
//   ・候補は2つ以上（日付が入った候補を「日付|時刻」でまとめて数える。補足だけ違う同じ日時は1件）
//   ・30件以内、日付は必須、同じ日時の重複なし、補足は50文字以内
//   ・時刻は「HH:MM」にそろえて比べる（編集時はDBの「HH:MM:SS」が来ることもあるため）
//   allowId: 編集時だけ、既存の候補のid（uuid）を受け付ける
function validateCandidates(candidates, { allowId }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { error: MIN_CANDIDATES_MESSAGE };
  }
  if (candidates.length > MAX_CANDIDATES) {
    return { error: `候補日時は${MAX_CANDIDATES}件以内にしてください` };
  }
  const readDate = (c) => (typeof c?.date === 'string' ? c.date.trim() : '');
  const readTime = (c) => (typeof c?.time === 'string' ? c.time.trim().slice(0, 5) : '');

  // 下の1件ずつのチェックより先に行い、同じ候補を2つ入れただけの場合も「2つ以上」の文言を返す
  const uniqueKeys = new Set();
  for (const candidate of candidates) {
    const date = readDate(candidate);
    if (!date) continue;
    uniqueKeys.add(`${date}|${readTime(candidate)}`);
  }
  if (uniqueKeys.size < MIN_CANDIDATES) {
    return { error: MIN_CANDIDATES_MESSAGE };
  }

  const normalized = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const date = readDate(candidate);
    if (!date) {
      return { error: '候補日を入力してください' };
    }
    const time = readTime(candidate);
    const key = `${date}|${time}`;
    if (seen.has(key)) {
      return { error: '同じ日時の候補が重複しています' };
    }
    seen.add(key);

    const note = typeof candidate?.note === 'string' ? candidate.note.trim() : '';
    if ([...note].length > CANDIDATE_NOTE_MAX_LENGTH) {
      return { error: `候補の補足は${CANDIDATE_NOTE_MAX_LENGTH}文字以内で入力してください` };
    }

    const item = { date, time: time || null, note: note || null };
    if (allowId && candidate?.id) {
      if (typeof candidate.id !== 'string' || !UUID_PATTERN.test(candidate.id)) {
        return { error: '候補の指定が正しくありません' };
      }
      item.id = candidate.id;
    }
    normalized.push(item);
  }
  return { normalized };
}

// POST /api/coordinations : 日程調整の新規作成（一般ユーザー・管理者どちらも可）
//   body: { branch, title, place, content, reply_deadline?, audience?, is_blind?, candidates: [{date, time?, note?}] }
//   作成者名はログインしている人の表示名（送られた created_by は使わない）
//   範囲（audience）を入れたときは、その支部の範囲の候補として自動で覚える（失敗しても作成は成功扱い）
//   is_blind: true ならブラインド（省略時は通常）。共有トークンはDBのトリガーが自動で作る（migration 0023）
//   coordinations 1行 + coordination_candidates 複数行をまとめて作成する。
//   候補作成に失敗した場合は、coordinations側も削除して中途半端な行を残さない
//   （1回のAPI呼び出しで2テーブルへの書き込みが必要だが、DB関数は使わず
//   コンペンセーティングアクション＝失敗時の後始末で対応している）
async function handleCreate(req, res) {
  const { branch, title, place, content, reply_deadline, audience, is_blind, candidates } = req.body || {};
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  if (!BRANCHES.includes(branch)) {
    return sendJson(res, 400, { error: '支部が不正です' });
  }

  const trimmedCreatedBy = writerName(actor);
  const fields = validateCoordinationFields({ title, place, content, reply_deadline });
  if (fields.error || !trimmedCreatedBy) {
    return sendJson(res, 400, { error: fields.error || '必須項目が不足しています' });
  }
  const { trimmedTitle, trimmedPlace, trimmedContent, trimmedDeadline } = fields;
  const audienceResult = parseAudience(audience);
  if (audienceResult.error) {
    return sendJson(res, 400, { error: audienceResult.error });
  }
  const audienceValue = audienceResult.keep ? null : audienceResult.value;
  const blindResult = parseIsBlind(is_blind);
  if (blindResult.error) {
    return sendJson(res, 400, { error: blindResult.error });
  }

  const candidateResult = validateCandidates(candidates, { allowId: false });
  if (candidateResult.error) {
    return sendJson(res, 400, { error: candidateResult.error });
  }
  const normalizedCandidates = candidateResult.normalized;

  const supabase = getSupabaseClient();

  const { data: coordination, error: coordinationError } = await supabase
    .from('coordinations')
    .insert({
      branch,
      title: trimmedTitle,
      place: trimmedPlace,
      content: trimmedContent,
      created_by: trimmedCreatedBy,
      created_by_user_id: writerId(actor),
      reply_deadline: trimmedDeadline || null,
      audience: audienceValue,
      is_blind: blindResult.keep ? false : blindResult.value,
    })
    .select()
    .single();

  if (coordinationError) {
    const { status, message } = coordinationErrorResponse(coordinationError);
    return sendJson(res, status, { error: message });
  }

  const { data: candidateRows, error: candidatesError } = await supabase
    .from('coordination_candidates')
    .insert(
      normalizedCandidates.map((c, index) => ({
        coordination_id: coordination.id,
        date: c.date,
        time: c.time,
        note: c.note,
        sort_order: index,
      }))
    )
    .select();

  if (candidatesError) {
    // 候補の作成に失敗した場合、候補ゼロのcoordinationsだけが残ると使い物にならないため、
    // 作成済みのcoordinations行を削除して後始末する（DB関数を使わない代わりの安全策）
    const { error: cleanupError } = await supabase.from('coordinations').delete().eq('id', coordination.id);
    if (cleanupError) {
      console.error('coordinations cleanup after candidates failure failed:', cleanupError);
    }
    const { status, message } = coordinationErrorResponse(candidatesError);
    return sendJson(res, status, { error: message });
  }

  // 範囲を支部の候補として自動保存（失敗しても作成自体は成功扱い。予定の場所と同じ）
  if (audienceValue) {
    await addBranchOption(supabase, { branch, type: 'audience', value: audienceValue });
  }

  return sendJson(res, 201, { ...coordination, coordination_candidates: candidateRows });
}

// PUT /api/coordinations?id=xxx : 日程調整の編集（作成者本人 or 管理者のみ。調整中のときだけ）
//   body: { title, place, content, reply_deadline?, audience?, is_blind?, candidates: [{id?, date, time?, note?}] }
//   作成者名は変更しない（作成者のユーザーIDで本人判定する）。
//   is_blind: 通常⇔ブラインドの切り替え。送られていなければ今のまま（トークンは切り替えても変わらない）。
//   範囲（audience）: 空なら範囲なし。送られていなければ今の値を残す。今の値から変えたときだけ候補として覚える
//   （変えなければ候補に入れない。候補管理で消した範囲が、そのままの保存で戻らないようにするため。備品の品名と同じ）。
//   候補は、既存の候補ならidを付けて渡す（idの無いものは新規追加、渡されなかった既存の候補は削除）。
//   調整本体と候補の更新は、DB関数 update_coordination が1トランザクションで行う
//   （行ロックにより決定処理と同時には走らない。決定済みならP0001で止まる）
async function handleUpdate(req, res, id) {
  const { title, place, content, reply_deadline, audience, is_blind, candidates } = req.body || {};
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  if (!UUID_PATTERN.test(id)) {
    return sendJson(res, 400, { error: 'IDの形式が正しくありません' });
  }

  const supabase = getSupabaseClient();

  const { data: existing, error: fetchError } = await supabase
    .from('coordinations')
    .select('branch, created_by_user_id, status, audience')
    .eq('id', id)
    .maybeSingle();
  if (fetchError || !existing) {
    return sendJson(res, 404, { error: '日程調整が見つかりません' });
  }
  if (!(await canActOnCoordination(actor, existing))) {
    return sendJson(res, 403, { error: 'この日程調整を編集できるのは、作成した本人か、この支部を管理する管理者だけです' });
  }
  // 画面で分かりやすい文言を返すための事前チェック。
  // 最終的な判定は、DB関数が行ロックを取ってから行う（この間に決定された場合もP0001で止まる）
  if (existing.status !== 'open') {
    return sendJson(res, 409, { error: '決定済みの日程調整は編集できません' });
  }

  const fields = validateCoordinationFields({ title, place, content, reply_deadline });
  if (fields.error) {
    return sendJson(res, 400, { error: fields.error });
  }
  const candidateResult = validateCandidates(candidates, { allowId: true });
  if (candidateResult.error) {
    return sendJson(res, 400, { error: candidateResult.error });
  }
  const audienceResult = parseAudience(audience);
  if (audienceResult.error) {
    return sendJson(res, 400, { error: audienceResult.error });
  }
  const audienceValue = audienceResult.keep ? existing.audience : audienceResult.value;
  const blindResult = parseIsBlind(is_blind);
  if (blindResult.error) {
    return sendJson(res, 400, { error: blindResult.error });
  }

  const { error } = await supabase.rpc('update_coordination', {
    p_coordination_id: id,
    p_title: fields.trimmedTitle,
    p_place: fields.trimmedPlace,
    p_content: fields.trimmedContent,
    p_reply_deadline: fields.trimmedDeadline || null,
    p_candidates: candidateResult.normalized,
    p_audience: audienceValue,
    p_is_blind: blindResult.keep ? null : blindResult.value, // null なら今のまま
  });
  if (error) {
    const { status, message } = updateErrorResponse(error);
    return sendJson(res, status, { error: message });
  }

  // 範囲を今の値から変えたときだけ、支部の候補として覚える（失敗しても編集自体は成功扱い）
  if (audienceValue && audienceValue !== existing.audience) {
    await addBranchOption(supabase, { branch: existing.branch, type: 'audience', value: audienceValue });
  }
  return sendJson(res, 200, { id });
}

// DELETE /api/coordinations?id=xxx : 日程調整の削除（作成者本人 or その支部を管理できる管理者のみ）
//   決定済みも削除できる。eventsはcoordinationsを参照していない（参照の向きは
//   coordinations.decided_event_id → events.id の一方向）ため、決定で作られた予定と参加者は残る
async function handleDelete(req, res, id) {
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;

  const supabase = getSupabaseClient();

  const { data: existing, error: fetchError } = await supabase
    .from('coordinations')
    .select('branch, created_by_user_id')
    .eq('id', id)
    .single();
  if (fetchError || !existing) {
    return sendJson(res, 404, { error: '日程調整が見つかりません' });
  }
  if (!(await canActOnCoordination(actor, existing))) {
    return sendJson(res, 403, { error: 'この日程調整を削除できるのは、作成した本人か、この支部を管理する管理者だけです' });
  }

  const { error } = await supabase.from('coordinations').delete().eq('id', id);
  if (error) {
    console.error('coordinations DELETE failed:', error);
    return sendJson(res, 500, { error: '削除に失敗しました。時間をおいて再度お試しください' });
  }
  return sendJson(res, 204, null);
}

// POST /api/coordinations?id=xxx&action=decide : 候補を決定してeventsへ登録（作成者本人 or その支部を管理できる管理者のみ）
//   作る予定の投稿者名は、決定した人の表示名（送られた decided_by は使わない）。
//   ユーザーIDも DB関数に渡す（p_decided_by_user_id。migration 0019。決定した人として coordinations.decided_by_user_id にも入る）
//   body: { candidate_id, add_to_schedule?, place, content, category?, time, end_time?, register_yes?, register_maybe? }
//   add_to_schedule（migration 0024）: false なら予定も参加者も作らず、調整だけを決定済みにする
//     （場所・内容・時刻・参加者登録は使わない）。送られていなければ true（今までどおり載せる）
//   権限チェックのみここで行い、実際の書き込みはDB関数 decide_coordination に任せる
//   （events作成・participants一括登録・coordinations更新を1トランザクションで行う）
async function handleDecide(req, res, id) {
  const { candidate_id, add_to_schedule, place, content, category, time, end_time, register_yes, register_maybe } =
    req.body || {};

  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;

  const trimmedDecidedBy = writerName(actor);
  if (!candidate_id) {
    return sendJson(res, 400, { error: '決定する候補を選択してください' });
  }
  if (add_to_schedule !== undefined && typeof add_to_schedule !== 'boolean') {
    return sendJson(res, 400, { error: 'スケジュールに載せるかの指定が正しくありません' });
  }
  const addToSchedule = add_to_schedule !== false;

  // 予定の内容は、スケジュールに載せるときだけ確かめる
  const trimmedPlace = typeof place === 'string' ? place.trim() : '';
  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  const trimmedTime = typeof time === 'string' ? time.trim() : '';
  const trimmedEndTime = typeof end_time === 'string' ? end_time.trim() : '';
  const trimmedCategory = typeof category === 'string' ? category.trim() : '';
  if (addToSchedule) {
    if (!trimmedPlace || !trimmedContent) {
      return sendJson(res, 400, { error: '場所と活動内容を入力してください' });
    }
    if (!trimmedTime) {
      return sendJson(res, 400, { error: '開始時刻を入力してください' });
    }
    if (trimmedEndTime && trimmedEndTime <= trimmedTime) {
      return sendJson(res, 400, { error: '終了時間は開始時間より後にしてください' });
    }
    if (trimmedCategory.length > CATEGORY_MAX_LENGTH) {
      return sendJson(res, 400, { error: `カテゴリは${CATEGORY_MAX_LENGTH}文字以内で入力してください` });
    }
    // 固定カテゴリ外の自由入力も許可する（events.categoryと同じ扱い。候補管理への自動登録は行わない）
  }

  const supabase = getSupabaseClient();

  const { data: existing, error: fetchError } = await supabase
    .from('coordinations')
    .select('branch, created_by_user_id')
    .eq('id', id)
    .single();
  if (fetchError || !existing) {
    return sendJson(res, 404, { error: '日程調整が見つかりません' });
  }
  if (!(await canActOnCoordination(actor, existing))) {
    return sendJson(res, 403, { error: 'この日程調整を決定できるのは、作成した本人か、この支部を管理する管理者だけです' });
  }

  const { data: eventId, error } = await supabase.rpc('decide_coordination', {
    p_coordination_id: id,
    p_candidate_id: candidate_id,
    p_decided_by: trimmedDecidedBy,
    p_place: addToSchedule ? trimmedPlace : null,
    p_content: addToSchedule ? trimmedContent : null,
    p_category: addToSchedule ? trimmedCategory || null : null,
    p_time: addToSchedule ? trimmedTime : null,
    p_end_time: addToSchedule ? trimmedEndTime || null : null,
    p_register_yes: addToSchedule && register_yes !== false,
    p_register_maybe: addToSchedule && register_maybe === true,
    p_decided_by_user_id: writerId(actor),
    p_add_to_schedule: addToSchedule,
  });

  if (error) {
    const { status, message } = decideErrorResponse(error);
    return sendJson(res, status, { error: message });
  }

  return sendJson(res, 200, { event_id: eventId }); // 載せないときは event_id: null
}

// POST /api/coordinations?id=xxx&action=reopen : スケジュールに載せなかった決定の取り消し（migration 0024）
//   作成者本人 or その支部を管理できる管理者のみ（決定と同じ）。
//   対象は「決定済み、かつ予定が空（decided_event_id が null）」の調整だけ。載せた決定は、スケジュール画面で
//   予定を削除すると DBトリガーで調整中に戻るため、ここでは扱わない（400）。
//   状態・決定した候補・決定日時・決定した人を空に戻す。回答はそのまま残る。
//   条件付きの1回の UPDATE で行う（決定と同時に走っても、どちらか一方しか成功しない。条件に合わなければ409）
async function handleReopen(req, res, id) {
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  if (!UUID_PATTERN.test(id)) {
    return sendJson(res, 400, { error: 'IDの形式が正しくありません' });
  }

  const supabase = getSupabaseClient();
  const { data: existing, error: fetchError } = await supabase
    .from('coordinations')
    .select('branch, created_by_user_id, status, decided_event_id')
    .eq('id', id)
    .maybeSingle();
  if (fetchError || !existing) {
    return sendJson(res, 404, { error: '日程調整が見つかりません' });
  }
  if (!(await canActOnCoordination(actor, existing))) {
    return sendJson(res, 403, { error: 'この日程調整の決定を取り消せるのは、作成した本人か、この支部を管理する管理者だけです' });
  }
  if (existing.status !== 'decided') {
    return sendJson(res, 409, { error: 'この日程調整は決定済みではありません。画面を読み直してください' });
  }
  if (existing.decided_event_id) {
    return sendJson(res, 400, {
      error: 'スケジュールに載せた決定は、スケジュール画面で予定を削除すると調整中に戻ります',
    });
  }

  const { data: updated, error } = await supabase
    .from('coordinations')
    .update({ status: 'open', decided_candidate_id: null, decided_at: null, decided_by_user_id: null })
    .eq('id', id)
    .eq('status', 'decided')
    .is('decided_event_id', null)
    .select('id');
  if (error) {
    console.error('coordinations reopen failed:', error);
    return sendJson(res, 500, { error: '決定の取り消しに失敗しました。時間をおいて再度お試しください' });
  }
  if (!updated || updated.length === 0) {
    return sendJson(res, 409, { error: 'この日程調整の状態が変わりました。画面を読み直してください' });
  }
  return sendJson(res, 200, { id });
}
