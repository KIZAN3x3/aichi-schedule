-- equipment.owner_branch / owner_person を追加
-- 備品の「所有」（支部）と「担当者」を記録する。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは新規構築用に既にowner_branch/owner_personカラムを反映済み。
--   既存プロジェクトにはこのマイグレーションを適用すること）

alter table public.equipment add column if not exists owner_branch text
  check (owner_branch is null or owner_branch in (
    '西県連','東県連',
    '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
    '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部',
    'その他'
  ));

alter table public.equipment add column if not exists owner_person text;
