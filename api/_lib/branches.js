// 16支部固定リスト（supabase/schema.sqlのCHECK制約と一致させること）
const BRANCHES = Array.from({ length: 16 }, (_, i) => `${i + 1}支部`);

// 備品のowner_branchがこれらの場合、is_sharedは常にtrueを強制する（県連所有＝県全体で使う前提のため）
const SHARED_OWNER_BRANCHES = ['西県連', '東県連'];

module.exports = { BRANCHES, SHARED_OWNER_BRANCHES };
