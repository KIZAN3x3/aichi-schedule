-- equipment.management_number を追加（任意）
-- 備品の管理番号を記録する。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは新規構築用に既にmanagement_numberカラムを反映済み。
--   既存プロジェクトにはこのマイグレーションを適用すること）

alter table public.equipment add column if not exists management_number text;
