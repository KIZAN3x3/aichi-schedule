// 固定カテゴリ8種＋「その他」（api/_lib/categories.js と値を一致させること）
export const FIXED_CATEGORIES = [
  '街頭活動',
  '訪問',
  'ポスティング',
  '事務作業',
  'お茶会',
  '勉強会',
  '定例会',
  'オンラインミーティング',
];

export const OTHER_CATEGORY = 'その他';

export const CATEGORY_OPTIONS = [...FIXED_CATEGORIES, OTHER_CATEGORY];

export const CATEGORY_COLORS = {
  街頭活動: '#f5871f',
  訪問: '#2f8f6b',
  ポスティング: '#3d7dd8',
  事務作業: '#6b6f76',
  お茶会: '#d6598c',
  勉強会: '#8a5cc9',
  定例会: '#c98b1f',
  オンラインミーティング: '#1fa3a3',
};

export const DEFAULT_CATEGORY_COLOR = '#a89684';

export function colorForCategory(category) {
  return CATEGORY_COLORS[category] || DEFAULT_CATEGORY_COLOR;
}

// 編集画面のプルダウン初期値を決める: 固定8種ならそのまま、それ以外(自由入力)は「その他」扱い
export function splitCategoryForEdit(category) {
  if (!category) return { select: '', other: '' };
  if (FIXED_CATEGORIES.includes(category)) return { select: category, other: '' };
  return { select: OTHER_CATEGORY, other: category };
}
