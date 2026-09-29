// 備品の品名・種類の入力（選択肢＋「新しく入力」）と、表記のそろえ方。
// 候補は全支部共通（api/branch-options.js の type=item_name / item_kind）。候補を覚えるのは API 側

// 表記をそろえる。api/_lib/branchOptions.js の normalizeOptionValue と同じ処理にすること
//   全角英数字→半角 / 半角カタカナ→全角 / 空白の連続→半角スペース1つ・前後の空白を除く / かっこ・記号・絵文字は変えない
export function normalizeOptionValue(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[｡-ﾟ]+/g, (s) => s.normalize('NFKC'))
    .replace(/\s+/g, ' ')
    .trim();
}

export const OPTION_MAX_LENGTH = 50;
const NEW_VALUE = '__new__';

// 選択肢＋「新しく入力」の入力欄（予定のカテゴリと同じ形）。
//   blankLabel : 先頭の空の選択肢の表示（品名は「選択してください」、種類は「種類なし」）
//   newLabel   : 「＋ 新しい品名を入力」など
//   currentSuffix: 候補に無い今の値を出すときの後ろの表示（「（今の品名）」など）
//   onChange   : 値が変わったとき（選び直し・入力）
// setChoices(values, current):
//   values  … 候補の一覧
//   current … 今の値（編集時）。候補に無ければ「今の値（今の品名）」として選択肢に足し、選んだ状態にする。
//             undefined なら、今の選択（新しく入力中ならその文字）をできるだけ保つ
// getValue(): 選んだ値、または「新しく入力」の文字（そろえるのは API 側。ここでは前後の空白だけ除く）
export function createOptionPicker({ blankLabel, newLabel, inputPlaceholder, currentSuffix, ariaLabel, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'option-picker';

  const select = document.createElement('select');
  if (ariaLabel) select.setAttribute('aria-label', ariaLabel);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'option-picker-input hidden';
  input.placeholder = inputPlaceholder;
  input.maxLength = OPTION_MAX_LENGTH;
  if (ariaLabel) input.setAttribute('aria-label', `${ariaLabel}（新しく入力）`);
  wrap.append(select, input);

  const syncInput = () => {
    const isNew = select.value === NEW_VALUE;
    input.classList.toggle('hidden', !isNew);
    return isNew;
  };
  select.addEventListener('change', () => {
    if (syncInput()) input.focus();
    if (onChange) onChange();
  });
  input.addEventListener('input', () => {
    if (onChange) onChange();
  });

  function setChoices(values, current) {
    const keepNew = current === undefined && select.value === NEW_VALUE;
    const keepValue = current === undefined ? select.value : current || '';
    select.innerHTML = '';
    select.appendChild(new Option(blankLabel, ''));
    const unique = [...new Set(values.filter(Boolean))];
    for (const value of unique) select.appendChild(new Option(value, value));
    if (current && !unique.includes(current)) {
      select.appendChild(new Option(`${current}${currentSuffix}`, current));
    }
    select.appendChild(new Option(newLabel, NEW_VALUE));
    if (keepNew) {
      select.value = NEW_VALUE;
    } else {
      select.value = [...select.options].some((o) => o.value === keepValue) ? keepValue : '';
      if (current === undefined && keepValue !== select.value) input.value = '';
    }
    syncInput();
  }

  function getValue() {
    return select.value === NEW_VALUE ? input.value.trim() : select.value;
  }

  function reset() {
    input.value = '';
    select.value = '';
    syncInput();
  }

  return { el: wrap, select, input, setChoices, getValue, reset };
}

// 種類の候補を品名ごとにまとめる。rows: [{ item_name, value }]
export function groupKindOptions(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.item_name)) map.set(row.item_name, []);
    map.get(row.item_name).push(row.value);
  }
  return map;
}

// 品名に合う種類の候補（新しく入力中の品名は、そろえた形で探す）
export function kindChoicesFor(kindOptions, itemName) {
  if (!itemName) return [];
  return kindOptions.get(itemName) || kindOptions.get(normalizeOptionValue(itemName)) || [];
}
