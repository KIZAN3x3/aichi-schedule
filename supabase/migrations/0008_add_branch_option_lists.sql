-- 支部ごとの「場所」「カテゴリ」自由入力候補を保存するテーブル
-- イベント登録時にapi/events.js側で自動的に追加され、次回以降の入力補完・プルダウン候補として使う。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは新規構築用に既に反映済み。既存プロジェクトにはこのマイグレーションを適用すること）

create table if not exists public.branch_place_options (
  id         uuid primary key default gen_random_uuid(),
  branch     text not null check (
               branch in (
                 '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                 '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
               )
             ),
  value      text not null,
  created_at timestamptz not null default now(),
  unique (branch, value)
);

create table if not exists public.branch_category_options (
  id         uuid primary key default gen_random_uuid(),
  branch     text not null check (
               branch in (
                 '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                 '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
               )
             ),
  value      text not null,
  created_at timestamptz not null default now(),
  unique (branch, value)
);

comment on table public.branch_place_options is '支部ごとに過去入力された「場所」の候補（datalist用）';
comment on table public.branch_category_options is '支部ごとに過去入力された自由入力「カテゴリ」の候補（プルダウン用）';

-- 読み取り(SELECT)はanonにも許可（events/equipmentと同じ考え方）。
-- 書き込み(INSERT)はanonには許可せず、api/branch-options.js（service role key）経由のみとする。
alter table public.branch_place_options    enable row level security;
alter table public.branch_category_options enable row level security;

create policy "branch_place_options_select_anon"    on public.branch_place_options    for select using (true);
create policy "branch_category_options_select_anon" on public.branch_category_options for select using (true);
