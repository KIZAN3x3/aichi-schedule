// 固定カテゴリ8種＋「その他」（選択時は自由入力テキストをcategoryにそのまま保存する）
const FIXED_CATEGORIES = [
  '街頭活動',
  '訪問',
  'ポスティング',
  '事務作業',
  'お茶会',
  '勉強会',
  '定例会',
  'オンラインミーティング',
];

const OTHER_CATEGORY = 'その他';

// UI表示用の選択肢一覧（固定8種 + その他）
const CATEGORY_OPTIONS = [...FIXED_CATEGORIES, OTHER_CATEGORY];

// 固定8カテゴリの配色（自由入力の「その他」はDEFAULT_CATEGORY_COLORを使う）
const CATEGORY_COLORS = {
  街頭活動: '#f5871f',
  訪問: '#2f8f6b',
  ポスティング: '#3d7dd8',
  事務作業: '#6b6f76',
  お茶会: '#d6598c',
  勉強会: '#8a5cc9',
  定例会: '#c98b1f',
  オンラインミーティング: '#1fa3a3',
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
