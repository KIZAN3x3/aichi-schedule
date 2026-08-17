// 固定カテゴリ17種＋「その他」
export const FIXED_CATEGORIES = [
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

export const OTHER_CATEGORY = 'その他';

export const CATEGORY_OPTIONS = [...FIXED_CATEGORIES, OTHER_CATEGORY];

export const CATEGORY_COLORS = {
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
  支部面談: '#a83fb0',
  オンラインミーティング: '#4a9c3f',
  ウグイス講習会: '#a24fc9',
  ドライバー講習会: '#47738a',
};

export const DEFAULT_CATEGORY_COLOR = '#a89684';

export function colorForCategory(category) {
  return CATEGORY_COLORS[category] || DEFAULT_CATEGORY_COLOR;
}

// カレンダーの丸アイコンに使う頭文字を割り当てる。
// 同じ文字で始まるカテゴリが複数ある場合は、重複しなくなるまで2文字目・3文字目…と伸ばす。
function assignUniqueIcon(category, usedLabels) {
  let len = 1;
  let label = category.slice(0, len);
  while (usedLabels.has(label) && len < category.length) {
    len += 1;
    label = category.slice(0, len);
  }
  usedLabels.add(label);
  return label;
}

// 固定16カテゴリの頭文字アイコンは常に同じ文字になるよう、あらかじめ一括計算しておく
export const CATEGORY_ICONS = (() => {
  const used = new Set();
  const map = {};
  for (const category of FIXED_CATEGORIES) {
    map[category] = assignUniqueIcon(category, used);
  }
  return map;
})();

// ある日の予定に含まれるカテゴリ（自由入力の「その他」含む）に対して、重複しないアイコン文字を割り当てる
export function iconsForCategories(categories) {
  const used = new Set();
  const result = {};

  for (const category of categories) {
    if (CATEGORY_ICONS[category]) {
      result[category] = CATEGORY_ICONS[category];
      used.add(CATEGORY_ICONS[category]);
    }
  }
  for (const category of categories) {
    if (!CATEGORY_ICONS[category]) {
      result[category] = assignUniqueIcon(category, used);
    }
  }
  return result;
}

// 編集画面のプルダウン初期値を決める: 固定16種ならそのまま、それ以外(自由入力)は「その他」扱い
export function splitCategoryForEdit(category) {
  if (!category) return { select: '', other: '' };
  if (FIXED_CATEGORIES.includes(category)) return { select: category, other: '' };
  return { select: OTHER_CATEGORY, other: category };
}
