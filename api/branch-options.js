const { getSupabaseClient } = require('./_lib/supabase');
const { resolveRole } = require('./_lib/auth');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES } = require('./_lib/branches');
const { TABLES, addBranchOption } = require('./_lib/branchOptions');

// GET  /api/branch-options?branch=◯◯&type=place|category : 支部ごとの過去入力候補を取得
// POST /api/branch-options { branch, type, value, password } : 候補を追加（重複はエラーにせず無視）
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const { branch, type } = req.query || {};
    if (!BRANCHES.includes(branch)) {
      return sendJson(res, 400, { error: '支部が不正です' });
    }
    const table = TABLES[type];
    if (!table) {
      return sendJson(res, 400, { error: 'typeはplaceまたはcategoryを指定してください' });
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from(table)
      .select('value')
      .eq('branch', branch)
      .order('value', { ascending: true });
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 200, data);
  }

  if (req.method === 'POST') {
    const { branch, type, value, password } = req.body || {};
    const role = resolveRole(password);
    if (!role) {
      return sendJson(res, 401, { error: 'パスワードが違います' });
    }
    if (!BRANCHES.includes(branch)) {
      return sendJson(res, 400, { error: '支部が不正です' });
    }
    if (!TABLES[type]) {
      return sendJson(res, 400, { error: 'typeはplaceまたはcategoryを指定してください' });
    }
    const trimmedValue = typeof value === 'string' ? value.trim() : '';
    if (!trimmedValue) {
      return sendJson(res, 400, { error: 'valueが必要です' });
    }

    const supabase = getSupabaseClient();
    await addBranchOption(supabase, { branch, type, value: trimmedValue });
    return sendJson(res, 201, { branch, type, value: trimmedValue });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
};
