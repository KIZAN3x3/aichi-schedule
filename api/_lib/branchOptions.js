// audience: 日程調整の「参加できる人の範囲」の候補（migration 0022）。日程調整の作成・編集で api/coordinations.js が自動で覚える
const TABLES = {
  place: 'branch_place_options',
  category: 'branch_category_options',
  audience: 'branch_audience_options',
};

// 備品の品名・種類の候補（全支部共通。migration 0021）
const EQUIPMENT_OPTION_TABLES = {
  item_name: 'equipment_item_name_options',
  item_kind: 'equipment_item_kind_options',
};
const EQUIPMENT_OPTION_MAX_LENGTH = 50;

// 支部ごとの入力候補を追加する。既に同じ(branch, value)があれば何もしない（エラーにしない）。
async function addBranchOption(supabase, { branch, type, value }) {
  const table = TABLES[type];
  if (!table || !value) return;

  const { error } = await supabase
    .from(table)
    .upsert({ branch, value }, { onConflict: 'branch,value', ignoreDuplicates: true });
  if (error) {
    console.error(`${table} upsert failed:`, error.message);
  }
}

// 備品の品名・種類の表記をそろえる（候補にも equipment にも、この形で保存する）。
// js/equipment-options.js の normalizeOptionValue と同じ処理にすること
//   ・全角英数字（Ａ〜Ｚ・ａ〜ｚ・０〜９）→ 半角
//   ・半角カタカナ（と半角の「。」「」」「、」「・」「ー」など）→ 全角（NFKC。濁点・半濁点も1文字にまとめる）
//   ・空白（半角・全角・タブ・改行）の連続 → 半角スペース1つ、前後の空白は除く
//   ・かっこ・記号・絵文字は変えない
// 文字列以外は '' を返す
function normalizeOptionValue(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[｡-ﾟ]+/g, (s) => s.normalize('NFKC'))
    .replace(/\s+/g, ' ')
    .trim();
}

// 品名の入力をそろえて確かめる。返り値: { value } か { error }（必須・1〜50文字）
function parseItemName(input) {
  const value = normalizeOptionValue(input);
  if (!value) return { error: '品目名を入力してください' };
  if ([...value].length > EQUIPMENT_OPTION_MAX_LENGTH) {
    return { error: `品目名は${EQUIPMENT_OPTION_MAX_LENGTH}文字以内で入力してください` };
  }
  return { value };
}

// 種類の入力をそろえて確かめる。返り値: { value }（空なら null）か { error }（任意・50文字以内）
function parseItemKind(input) {
  if (input !== undefined && input !== null && typeof input !== 'string') {
    return { error: '種類の形式が正しくありません' };
  }
  const value = normalizeOptionValue(input || '');
  if ([...value].length > EQUIPMENT_OPTION_MAX_LENGTH) {
    return { error: `種類は${EQUIPMENT_OPTION_MAX_LENGTH}文字以内で入力してください` };
  }
  return { value: value || null };
}

// 備品の品名・種類の候補を覚える。既にあれば何もしない。失敗しても備品の登録・編集は成功扱い（場所の候補と同じ）
//   itemName: 品名を覚えるとき（そろえた値）。null なら品名は覚えない
//   kind    : 種類を覚えるとき { itemName, value }（そろえた値）。null なら種類は覚えない
async function addEquipmentOptions(supabase, { itemName = null, kind = null }) {
  if (itemName) {
    const { error } = await supabase
      .from(EQUIPMENT_OPTION_TABLES.item_name)
      .upsert({ value: itemName }, { onConflict: 'value', ignoreDuplicates: true });
    if (error) console.error('equipment_item_name_options upsert failed:', error.message);
  }
  if (kind && kind.itemName && kind.value) {
    const { error } = await supabase
      .from(EQUIPMENT_OPTION_TABLES.item_kind)
      .upsert({ item_name: kind.itemName, value: kind.value }, { onConflict: 'item_name,value', ignoreDuplicates: true });
    if (error) console.error('equipment_item_kind_options upsert failed:', error.message);
  }
}

module.exports = {
  TABLES,
  EQUIPMENT_OPTION_TABLES,
  EQUIPMENT_OPTION_MAX_LENGTH,
  addBranchOption,
  normalizeOptionValue,
  parseItemName,
  parseItemKind,
  addEquipmentOptions,
};
