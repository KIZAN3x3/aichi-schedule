// 16支部固定リスト（supabase/schema.sqlのCHECK制約と一致させること）
const BRANCHES = Array.from({ length: 16 }, (_, i) => `${i + 1}支部`);

module.exports = { BRANCHES };
