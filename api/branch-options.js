const { getSupabaseClient } = require('./_lib/supabase');
const { resolveActor } = require('./_lib/auth');
const { regionResolverFor, canManageBranch, forbiddenMessage } = require('./_lib/permissions');
const { sendJson, methodNotAllowed } = require('./_lib/http');
const { BRANCHES } = require('./_lib/branches');
const { TABLES, addBranchOption } = require('./_lib/branchOptions');

// GET    /api/branch-options?branch=◯◯&type=place|category    : 支部ごとの過去入力候補を取得
// POST   /api/branch-options { branch, type, value, password } : 候補を追加（重複はエラーにせず無視）
// DELETE /api/branch-options { id, type, password }            : 候補を削除
// 追加・削除は「入力候補の管理」の権限（その支部を管理できる管理者: システム管理者・その県連の県連管理者・
// 共通パスワードの管理者）。予定の投稿時の自動追加（api/_lib/branchOptions.js）はこのAPIを通らないため影響しない
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
      .select('id, value')
      .eq('branch', branch)
      .order('value', { ascending: true });
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 200, data);
  }

  if (req.method === 'POST') {
    const { branch, type, value, password } = req.body || {};
    const auth = await resolveActor(req, password);
    if (!auth.ok) {
      return sendJson(res, auth.status, { error: auth.error });
    }
    const { actor } = auth;
    if (!BRANCHES.includes(branch)) {
      return sendJson(res, 400, { error: '支部が不正です' });
    }
    if (!canManageBranch(actor, branch, await regionResolverFor(actor))) {
      return sendJson(res, 403, {
        error: forbiddenMessage(actor, '候補の追加はマスター管理者のみ可能です', 'この支部の入力候補を管理できるのは、この支部を管理する管理者だけです'),
      });
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

  if (req.method === 'DELETE') {
    const { id, type, password } = req.body || {};
    const auth = await resolveActor(req, password);
    if (!auth.ok) {
      return sendJson(res, auth.status, { error: auth.error });
    }
    const { actor } = auth;
    const table = TABLES[type];
    if (!table) {
      return sendJson(res, 400, { error: 'typeはplaceまたはcategoryを指定してください' });
    }
    if (!id) {
      return sendJson(res, 400, { error: 'idが必要です' });
    }

    const supabase = getSupabaseClient();
    const { data: existing, error: fetchError } = await supabase.from(table).select('branch').eq('id', id).maybeSingle();
    if (fetchError || !existing) {
      return sendJson(res, 404, { error: '候補が見つかりません' });
    }
    if (!canManageBranch(actor, existing.branch, await regionResolverFor(actor))) {
      return sendJson(res, 403, {
        error: forbiddenMessage(actor, '削除はマスター管理者のみ可能です', 'この支部の入力候補を管理できるのは、この支部を管理する管理者だけです'),
      });
    }

    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) {
      return sendJson(res, 500, { error: error.message });
    }
    return sendJson(res, 204, null);
  }

  return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
};
