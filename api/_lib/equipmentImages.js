// 備品の画像（Supabase Storage のバケット equipment-images）の扱い（段階5 ③）
//   ・DBの equipment.image_url には、今までどおり公開URLの形
//       <SUPABASE_URL>/storage/v1/object/public/equipment-images/items/<uuid>.<拡張子>
//     を入れる（書き換えない。新しい画像も同じ形）。画面はこのURLを直接は使わず、場所（items/<uuid>.<拡張子>）だけを取り出す
//   ・画面に出す画像は、期限付きURL（1時間）。API（service_role）がまとめて作る（POST /api/equipment?action=image_urls）。
//     service_role で作るので、バケットを非公開にしても（段階5 ④）、Storage に読み取りのポリシーが無くても作れる

const BUCKET = 'equipment-images';
// 画像の場所の形（api/equipment/upload-url.js が作る形と同じ。拡張子は png・jpg・webp・gif）
const IMAGE_PATH_PATTERN = /^items\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;
const SIGNED_URL_EXPIRES_IN = 60 * 60; // 秒（1時間）
const MAX_PATHS_PER_REQUEST = 100;

// このバケットの公開URLの頭（例: https://xxxx.supabase.co/storage/v1/object/public/equipment-images/）
function publicUrlPrefix() {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${BUCKET}/`;
}

// 備品の登録・編集で受け付ける画像URLか（このバケットの公開URLの形で、場所の形も正しいもの）
function isOwnImageUrl(url) {
  if (typeof url !== 'string') return false;
  const prefix = publicUrlPrefix();
  return url.startsWith(prefix) && IMAGE_PATH_PATTERN.test(url.slice(prefix.length));
}

// 場所の一覧から、期限付きURLをまとめて作る。返り値: { 場所: 期限付きURL }（作れなかった場所は入れない）
async function signImagePaths(supabase, paths) {
  const result = {};
  if (paths.length === 0) return result;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_EXPIRES_IN);
  if (error) throw error;
  for (const row of data || []) {
    if (row.path && row.signedUrl && !row.error) result[row.path] = row.signedUrl;
  }
  return result;
}

module.exports = {
  BUCKET,
  IMAGE_PATH_PATTERN,
  SIGNED_URL_EXPIRES_IN,
  MAX_PATHS_PER_REQUEST,
  isOwnImageUrl,
  signImagePaths,
};
