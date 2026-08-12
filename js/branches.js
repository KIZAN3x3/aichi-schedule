// 16支部固定リスト（supabase/schema.sql, api/_lib/branches.js と一致させること）
export const BRANCHES = Array.from({ length: 16 }, (_, i) => `${i + 1}支部`);
