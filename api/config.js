const { sendJson, methodNotAllowed } = require('./_lib/http');

// GET /api/config : フロントエンドがSupabaseに直接接続(SELECT/Realtime)するための公開情報。
// anon/publishable keyはRLSで保護されている前提でブラウザに渡してよい値。
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return sendJson(res, 500, { error: 'SUPABASE_URL / SUPABASE_ANON_KEY が設定されていません' });
  }

  // デプロイごとに固定の値（環境変数）なので、ブラウザ・CDNで1時間使い回してよい
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return sendJson(res, 200, { supabaseUrl, supabaseAnonKey });
};
