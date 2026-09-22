const { getSupabaseClient } = require('../../_lib/supabase');
const { resolveRole } = require('../../_lib/auth');
const { sendJson, methodNotAllowed } = require('../../_lib/http');

const CATEGORY_MAX_LENGTH = 50;

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

// POST /api/coordinations/:id/decide : 候補を決定してeventsへ登録（作成者本人 or 管理者のみ）
//   body: { decided_by, candidate_id, place, content, category?, time, end_time?,
//           register_yes?, register_maybe?, password }
//   権限チェックのみここで行い、実際の書き込みはDB関数 decide_coordination に任せる
//   （events作成・participants一括登録・coordinations更新を1トランザクションで行う）
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { id } = req.query;
  const {
    decided_by,
    candidate_id,
    place,
    content,
    category,
    time,
    end_time,
    register_yes,
    register_maybe,
    password,
  } = req.body || {};

  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }

  const trimmedDecidedBy = typeof decided_by === 'string' ? decided_by.trim() : '';
  if (!trimmedDecidedBy) {
    return sendJson(res, 400, { error: '決定操作をした人の名前を入力してください' });
  }
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
    .select('created_by')
    .eq('id', id)
    .single();
  if (fetchError || !existing) {
    return sendJson(res, 404, { error: '日程調整が見つかりません' });
  }
  if (role !== 'admin' && existing.created_by !== trimmedDecidedBy) {
    return sendJson(res, 403, { error: '作成者本人または管理者のみ決定できます' });
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
  });

  if (error) {
    const { status, message } = decideErrorResponse(error);
    return sendJson(res, status, { error: message });
  }

  return sendJson(res, 200, { event_id: eventId });
};
