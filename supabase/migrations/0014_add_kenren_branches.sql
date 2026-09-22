-- 支部の選択肢に「西県連」「東県連」を追加
-- 既存行（events / branch_place_options / branch_category_options）は一切変更しない。
-- CHECK制約の差し替えのみ。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは今回は未反映。反映済みの他マイグレーションと同様、後日まとめて反映する）
-- 何度実行しても壊れないよう、drop constraint if exists → add constraint の形にしている

begin;

alter table public.events
  drop constraint if exists events_branch_check;
alter table public.events
  add constraint events_branch_check check (
    branch in (
      '西県連','東県連',
      '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
      '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
    )
  );

alter table public.branch_place_options
  drop constraint if exists branch_place_options_branch_check;
alter table public.branch_place_options
  add constraint branch_place_options_branch_check check (
    branch in (
      '西県連','東県連',
      '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
      '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
    )
  );

alter table public.branch_category_options
  drop constraint if exists branch_category_options_branch_check;
alter table public.branch_category_options
  add constraint branch_category_options_branch_check check (
    branch in (
      '西県連','東県連',
      '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
      '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
    )
  );

commit;
