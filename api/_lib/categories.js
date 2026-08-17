// 固定カテゴリ17種（js/categories.js の FIXED_CATEGORIES と一致させること）
// api/events.js で、投稿されたcategoryが固定リスト外（＝自由入力の「その他」）かどうかの判定に使う。
const FIXED_CATEGORIES = [
  '定例会',
  '勉強会',
  '駅立ち',
  '辻立ち',
  'お茶会',
  'ポスティング大会',
  'タウンミーティング',
  '候補者説明会',
  'ランチ会',
  '街宣車リレー',
  '街頭演説',
  'チラシ折り会',
  '報告会',
  '支部面談',
  'オンラインミーティング',
  'ウグイス講習会',
  'ドライバー講習会',
];

module.exports = { FIXED_CATEGORIES };
