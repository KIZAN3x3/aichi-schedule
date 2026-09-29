const { getSupabaseClient } = require('./_lib/supabase');
const { resolveActor } = require('./_lib/auth');
const { writerName, writerId } = require('./_lib/permissions');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES } = require('./_lib/branches');
const { FIXED_CATEGORIES } = require('./_lib/categories');
const { addBranchOption } = require('./_lib/branchOptions');

// POST /api/events : 新規予定投稿（一般ユーザー・管理者どちらも可）
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { branch, date, time, end_time, place, content, category } = req.body || {};
  const auth = await resolveActor(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const { actor } = auth;
  // 投稿者名: ログインしている人の表示名（送られた値は使わない）
  const poster_name = writerName(actor);
  if (!BRANCHES.includes(branch)) {
    return sendJson(res, 400, { error: '支部が不正です' });
  }
  if (!date || !time || !place || !content || !poster_name) {
    return sendJson(res, 400, { error: '必須項目が不足しています' });
  }
  const trimmedCategory = typeof category === 'string' ? category.trim() : '';
  if (trimmedCategory.length > 50) {
    return sendJson(res, 400, { error: 'カテゴリは50文字以内で入力してください' });
  }
  const trimmedEndTime = typeof end_time === 'string' ? end_time.trim() : '';
  if (trimmedEndTime && trimmedEndTime <= time) {
    return sendJson(res, 400, { error: '終了時間は開始時間より後にしてください' });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('events')
    .insert({
      branch,
      date,
      time,
      end_time: trimmedEndTime || null,
      place,
      content,
      poster_name,
      poster_user_id: writerId(actor),
      category: trimmedCategory || null,
    })
    .select()
    .single();

  if (error) {
    return sendJson(res, 500, { error: error.message });
  }

  // 場所・自由入力カテゴリを支部の候補として自動保存（失敗しても投稿自体は成功扱い）
  await addBranchOption(supabase, { branch, type: 'place', value: place.trim() });
  if (trimmedCategory && !FIXED_CATEGORIES.includes(trimmedCategory)) {
    await addBranchOption(supabase, { branch, type: 'category', value: trimmedCategory });
  }

  return sendJson(res, 201, data);
};
