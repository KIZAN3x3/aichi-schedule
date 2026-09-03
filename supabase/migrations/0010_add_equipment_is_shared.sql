-- equipment.is_shared を追加
-- 「全体で使用」フラグ。西県連・東県連所有の備品は常にtrue（API側で強制）。
-- 支部所有でも県全体で使う備品はtrueにできる。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは新規構築用に既にis_sharedカラムを反映済み。
--   既存プロジェクトにはこのマイグレーションを適用すること）

alter table public.equipment add column if not exists is_shared boolean not null default false;

-- 既存行のうち、西県連・東県連所有のものだけをtrueにbackfillする
-- （支部所有の既存備品はfalseのまま。必要なものは手動でチェックを入れる運用）
update public.equipment
set is_shared = true
where owner_branch in ('西県連', '東県連')
  and is_shared = false;
