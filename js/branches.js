// 支部固定リスト（西県連・東県連 + 1支部〜16支部、supabase/schema.sql, api/_lib/branches.js と一致させること）
export const BRANCHES = [
  '西県連',
  '東県連',
  ...Array.from({ length: 16 }, (_, i) => `${i + 1}支部`),
];
