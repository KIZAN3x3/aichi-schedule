const { getSupabaseClient } = require('../_lib/supabase');
const { resolveRole } = require('../_lib/auth');
const { sendJson, methodNotAllowed } = require('../_lib/http');

// GET /api/coordinations/:id    日程調整1件を候補・回答・回答内容込みで取得（専用URL用・認証不要）
//   api/config.js と同じ「読み取り専用の公開API」。存在しない/削除済みの場合は404を返し、
//   フロント（coordination.html）は404を「見つかりませんでした」表示の判定に使う
// DELETE /api/coordinations/:id 日程調整の削除（作成者本人 or 管理者のみ。決定済みは削除不可）
module.exports = async (req, res) => {
  const { id } = req.query;
  const supabase = getSupabaseClient();

  if (req.method === 'GET') {
    // coordinationsとcoordination_candidatesの間には外部キーが2本ある
    // （coordination_candidates.coordination_id と coordinations.decided_candidate_id）ため、
    // どちらのリレーションを辿るか!<fk名>で明示する必要がある（省略するとPGRST201で曖昧エラーになる）
    const { data, error } = await supabase
      .from('coordinations')
      .select(
        '*, coordination_candidates!coordination_candidates_coordination_id_fkey(*), coordination_responses(*, coordination_answers(*))'
      )
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('coordinations GET failed:', error);
      return sendJson(res, 500, { error: '日程調整の取得に失敗しました' });
    }
    if (!data) {
      return sendJson(res, 404, { error: '日程調整が見つかりません' });
    }
    return sendJson(res, 200, data);
  }

  if (req.method === 'DELETE') {
    const { created_by, password } = req.body || {};
    const role = resolveRole(password);
    if (!role) {
      return sendJson(res, 401, { error: 'パスワードが違います' });
    }
    if (!created_by) {
      return sendJson(res, 400, { error: 'created_byが必要です' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('coordinations')
      .select('created_by, status')
      .eq('id', id)
      .single();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '日程調整が見つかりません' });
    }
    if (role !== 'admin' && existing.created_by !== created_by) {
      return sendJson(res, 403, { error: '作成者本人のみ削除できます' });
    }
    if (existing.status === 'decided') {
      return sendJson(res, 400, {
        error: '決定済みの日程調整は削除できません。先に作成された予定を削除すると調整中に戻ります',
      });
    }

    const { error } = await supabase.from('coordinations').delete().eq('id', id);
    if (error) {
      console.error('coordinations DELETE failed:', error);
      return sendJson(res, 500, { error: '削除に失敗しました。時間をおいて再度お試しください' });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['GET', 'DELETE']);
};
