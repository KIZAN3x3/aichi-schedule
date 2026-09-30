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

// Vercel Hobbyプランのサーバーレス関数数上限（12個）を超えないよう、
// 元は3ファイルだった以下のエンドポイントをこの1ファイルにまとめている。
// 「/:id」「/:id/decide」というパス区切りの代わりに、クエリ文字列(?id=&action=)で分岐する。
//   GET    /api/coordinations?branch=xxx           : その支部のブラインドの調整のうち、見てよい人に当たるもの（migration 0023）
//   GET    /api/coordinations?token=xxx            : トークンの調整1件（coordination.html?t= のリンク用）
//   GET    /api/coordinations?id=xxx               : 1件（通常の調整か、見てよい人のときだけ）
//   POST   /api/coordinations                     : 新規作成（旧 api/coordinations.js）
//   PUT    /api/coordinations?id=xxx               : 編集（調整中のときだけ。DB関数update_coordination）
//   DELETE /api/coordinations?id=xxx               : 削除（旧 api/coordinations/[id].js）
//   POST   /api/coordinations?id=xxx&action=decide : 決定（旧 api/coordinations/[id]/decide.js）
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
  const { branch, token, id } = req.query;
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  const supabase = getSupabaseClient();

  try {
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
//   ユーザーIDも DB関数に渡す（p_decided_by_user_id。migration 0019）
//   body: { candidate_id, place, content, category?, time, end_time?, register_yes?, register_maybe? }
//   権限チェックのみここで行い、実際の書き込みはDB関数 decide_coordination に任せる
//   （events作成・participants一括登録・coordinations更新を1トランザクションで行う）
async function handleDecide(req, res, id) {
  const { candidate_id, place, content, category, time, end_time, register_yes, register_maybe } = req.body || {};

  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;

  const trimmedDecidedBy = writerName(actor);
  if (!candidate_id) {
    return sendJson(res, 400, { error: '決定する候補を選択してください' });
  }
  const trimmedPlace = typeof place === 'string' ? place.trim() : '';
  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  if (!trimmedPlace || !trimmedContent) {
    return sendJson(res, 400, { error: '場所と活動内容を入力してください' });
  }
  const trimmedTime = typeof time === 'string' ? time.trim() : '';
  if (!trimmedTime) {
    return sendJson(res, 400, { error: '開始時刻を入力してください' });
  }
  const trimmedEndTime = typeof end_time === 'string' ? end_time.trim() : '';
  if (trimmedEndTime && trimmedEndTime <= trimmedTime) {
    return sendJson(res, 400, { error: '終了時間は開始時間より後にしてください' });
  }
  const trimmedCategory = typeof category === 'string' ? category.trim() : '';
  if (trimmedCategory.length > CATEGORY_MAX_LENGTH) {
    return sendJson(res, 400, { error: `カテゴリは${CATEGORY_MAX_LENGTH}文字以内で入力してください` });
  }
  // 固定カテゴリ外の自由入力も許可する（events.categoryと同じ扱い。候補管理への自動登録は行わない）

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
    p_place: trimmedPlace,
    p_content: trimmedContent,
    p_category: trimmedCategory || null,
    p_time: trimmedTime,
    p_end_time: trimmedEndTime || null,
    p_register_yes: register_yes !== false,
    p_register_maybe: register_maybe === true,
    p_decided_by_user_id: writerId(actor),
  });

  if (error) {
    const { status, message } = decideErrorResponse(error);
    return sendJson(res, status, { error: message });
  }

  return sendJson(res, 200, { event_id: eventId });
}
