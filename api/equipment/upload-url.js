const { randomUUID } = require('crypto');
const { getSupabaseClient } = require('../_lib/supabase');
const { resolveRole } = require('../_lib/auth');
const { sendJson, methodNotAllowed } = require('../_lib/http');

const BUCKET = 'equipment-images';
const ALLOWED_CONTENT_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// POST /api/equipment/upload-url : 画像アップロード用の署名付きURLを発行
// 実際の画像バイト列はブラウザからSupabase Storageへ直接PUTする
// （Vercel関数のリクエストサイズ上限を避けるため、本文はここを通さない）
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const { contentType, password } = req.body || {};
  const role = resolveRole(password);
  if (!role) {
    return sendJson(res, 401, { error: 'パスワードが違います' });
  }
  const ext = ALLOWED_CONTENT_TYPES[contentType];
  if (!ext) {
    return sendJson(res, 400, { error: '対応していない画像形式です（PNG/JPEG/WebP/GIFのみ）' });
  }

  const path = `items/${randomUUID()}.${ext}`;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) {
    return sendJson(res, 500, { error: error.message });
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return sendJson(res, 200, {
    path,
    token: data.token,
    publicUrl: pub.publicUrl,
  });
};
