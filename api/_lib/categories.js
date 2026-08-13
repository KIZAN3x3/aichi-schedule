// 固定カテゴリ16種＋「その他」（選択時は自由入力テキストをcategoryにそのまま保存する）
// js/categories.js と値を一致させること
const FIXED_CATEGORIES = [
  '立上げ会議',
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
  'ウグイス講習会',
  'ドライバー講習会',
];

const OTHER_CATEGORY = 'その他';

// UI表示用の選択肢一覧（固定16種 + その他）
const CATEGORY_OPTIONS = [...FIXED_CATEGORIES, OTHER_CATEGORY];

// 固定16カテゴリの配色（自由入力の「その他」はDEFAULT_CATEGORY_COLORを使う）
const CATEGORY_COLORS = {
  立上げ会議: '#f5871f',
  定例会: '#c98b1f',
  勉強会: '#8a5cc9',
  駅立ち: '#2f8f6b',
  辻立ち: '#1f9e57',
  お茶会: '#d6598c',
  ポスティング大会: '#3d7dd8',
  タウンミーティング: '#1fa3a3',
  候補者説明会: '#b23b3b',
  ランチ会: '#e0a72e',
  街宣車リレー: '#6b6f76',
  街頭演説: '#d84315',
  チラシ折り会: '#5c7fb8',
  報告会: '#7a8c3f',
  ウグイス講習会: '#a24fc9',
  ドライバー講習会: '#47738a',
};

const DEFAULT_CATEGORY_COLOR = '#a89684';

function colorForCategory(category) {
  return CATEGORY_COLORS[category] || DEFAULT_CATEGORY_COLOR;
}

module.exports = {
  FIXED_CATEGORIES,
  OTHER_CATEGORY,
  CATEGORY_OPTIONS,
  CATEGORY_COLORS,
  DEFAULT_CATEGORY_COLOR,
  colorForCategory,
};
