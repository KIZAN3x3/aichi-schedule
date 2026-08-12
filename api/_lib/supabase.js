const { createClient } = require('@supabase/supabase-js');

let client;

// service role keyを使うサーバー専用クライアント。RLSをバイパスするため、
// 権限チェック（自分の投稿のみ編集可 等）は呼び出し側で必ず行うこと。
function getSupabaseClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が設定されていません');
    }
    client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

module.exports = { getSupabaseClient };
