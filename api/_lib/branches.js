// 支部固定リスト（西県連・東県連 + 1支部〜16支部、supabase/schema.sqlのCHECK制約と一致させること）
const BRANCHES = [
  '西県連',
  '東県連',
  ...Array.from({ length: 16 }, (_, i) => `${i + 1}支部`),
];

// 備品のowner_branchがこれらの場合、is_sharedは常にtrueを強制する（県連所有＝県全体で使う前提のため）
const SHARED_OWNER_BRANCHES = ['西県連', '東県連'];

// 備品の所有（owner_branch）の選択肢。18支部＋その他の19択（未定は空欄＝null）。
// supabase/schema.sql の equipment.owner_branch の CHECK制約、js/owner-branches.js と一致させること
const OWNER_BRANCHES = [...BRANCHES, 'その他'];

module.exports = { BRANCHES, SHARED_OWNER_BRANCHES, OWNER_BRANCHES };
