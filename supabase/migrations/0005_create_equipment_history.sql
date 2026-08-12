-- equipment_history: 備品の保管場所移動履歴（初回登録時の記録を含む）
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは新規構築用に既にequipment_historyを反映済み。
--   既存プロジェクトにはこのマイグレーションを適用すること）

create table if not exists public.equipment_history (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references public.equipment (id) on delete cascade,
  location      text not null,
  moved_by      text not null,
  moved_at      timestamptz not null default now()
);

comment on table public.equipment_history is '備品の保管場所移動履歴（登録時の初回記録を含む、新しい順で表示）';

create index if not exists idx_equipment_history_equipment_id on public.equipment_history (equipment_id, moved_at desc);

alter table public.equipment_history enable row level security;

create policy "equipment_history_select_anon" on public.equipment_history for select using (true);

alter publication supabase_realtime add table public.equipment_history;
