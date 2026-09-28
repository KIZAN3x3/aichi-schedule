-- Googleログイン＋RLS移行 段階2: ユーザー管理テーブルとユーザーID列の追加
--   ・app_users: Supabase Auth のユーザー（auth.users）ごとの表示名・支部・承認状態・管理者の種類
--   ・branch_regions: 支部と県連（西／東）の対応表（初期データ18行）
--   ・既存テーブルに null 可のユーザーID列（app_users.id を参照）を追加
--
-- 方針:
--   ・既存データは一切削除・変更しない（追加のみ。既存行の新しい列は null のまま、名前からの backfill はしない）
--   ・既存テーブルの RLS ポリシーは変更しない
--   ・app_users / branch_regions は RLS を有効にしてポリシーを作らない = service_role からのみアクセスできる
--     （Realtime の publication にも追加しない）
--   ・外部キーの on delete は既定の no action。ユーザーは削除せず status を disabled にする運用のため、
--     予定などから参照されているユーザーは削除できない（既存行が書き換わったり消えたりしない）
--   ・権限の判定（グランドマスター／県連管理者／支部管理者／一般）は段階3の API で行う。ここでは列を用意するだけ
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- 何度実行しても壊れないよう create table if not exists / add column if not exists /
-- create index if not exists / on conflict do nothing を使っている

begin;

-- ------------------------------------------------------------
-- branch_regions: 支部と県連の対応表
-- ------------------------------------------------------------
create table if not exists public.branch_regions (
  branch  text primary key,
  region  text not null
            constraint branch_regions_region_check check (region in ('西', '東'))
);

comment on table public.branch_regions is '支部と県連（西／東）の対応表。県連管理者の権限範囲の判定に使う';

insert into public.branch_regions (branch, region) values
  ('西県連', '西'),
  ('1支部', '西'), ('2支部', '西'), ('3支部', '西'), ('4支部', '西'), ('5支部', '西'),
  ('6支部', '西'), ('7支部', '西'), ('8支部', '西'), ('9支部', '西'), ('10支部', '西'),
  ('16支部', '西'),
  ('東県連', '東'),
  ('11支部', '東'), ('12支部', '東'), ('13支部', '東'), ('14支部', '東'), ('15支部', '東')
on conflict (branch) do nothing;

alter table public.branch_regions enable row level security;

-- ------------------------------------------------------------
-- app_users: アプリの利用者（Supabase Auth のユーザーごとに1行）
-- ------------------------------------------------------------
-- ※ btrim の文字集合 E' \t\r\n　' の末尾は全角スペース(U+3000)の実文字（0013 と同一）
create table if not exists public.app_users (
  id             uuid primary key references auth.users (id),
  display_name   text not null
                   constraint app_users_display_name_check check (
                     display_name = btrim(display_name, E' \t\r\n　')
                     and char_length(display_name) between 1 and 50
                   ),
  branch         text not null
                   constraint app_users_branch_check check (
                     branch in (
                       '西県連','東県連',
                       '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                       '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
                     )
                   ),
  status         text not null default 'pending'
                   constraint app_users_status_check check (status in ('pending', 'active', 'disabled')),
  is_admin       boolean not null default false,
  admin_scope    text
                   constraint app_users_admin_scope_check check (admin_scope is null or admin_scope in ('branch', 'region')),
  created_at     timestamptz not null default now(),
  approved_at    timestamptz,
  approved_by    uuid references public.app_users (id),
  last_login_at  timestamptz
);

comment on table public.app_users is 'アプリの利用者（auth.users と1対1）。service_role からのみアクセスする';
comment on column public.app_users.display_name is '表示名（登録時に本人が入力。別支部の同名の人がいるため一意にしない）';
comment on column public.app_users.branch is '所属支部（登録時に本人が入力）';
comment on column public.app_users.status is '状態: pending=承認待ち / active=有効 / disabled=無効（退会者は削除せずdisabledにする）';
comment on column public.app_users.is_admin is 'true=グランドマスター（全支部で全権限）';
comment on column public.app_users.admin_scope is 'region=県連管理者（自分の県連内で全権限） / branch=支部管理者（自分の支部のユーザーの承認・無効化のみ） / null=一般';
comment on column public.app_users.approved_at is '承認日時（承認待ちの間はnull）';
comment on column public.app_users.approved_by is '承認した管理者（app_users.id）';
comment on column public.app_users.last_login_at is '最終ログイン日時（ログイン時のみ更新）';

create index if not exists idx_app_users_status on public.app_users (status);

alter table public.app_users enable row level security;

-- ------------------------------------------------------------
-- 既存テーブルへのユーザーID列の追加（null可。既存行はnullのまま）
-- ------------------------------------------------------------
alter table public.events
  add column if not exists poster_user_id uuid references public.app_users (id);

alter table public.participants
  add column if not exists participant_user_id uuid references public.app_users (id);
alter table public.participants
  add column if not exists registered_by_user_id uuid references public.app_users (id);

alter table public.coordinations
  add column if not exists created_by_user_id uuid references public.app_users (id);

alter table public.coordination_responses
  add column if not exists participant_user_id uuid references public.app_users (id);
alter table public.coordination_responses
  add column if not exists registered_by_user_id uuid references public.app_users (id);

alter table public.equipment
  add column if not exists updated_by_user_id uuid references public.app_users (id);

alter table public.equipment_history
  add column if not exists moved_by_user_id uuid references public.app_users (id);

comment on column public.events.poster_user_id is '作成者（app_users.id）。移行前の行はnull';
comment on column public.participants.participant_user_id is '参加者本人（app_users.id）。移行前の行・アカウントの無い人の代理登録はnull';
comment on column public.participants.registered_by_user_id is 'この参加登録をした人（app_users.id）。移行前の行はnull';
comment on column public.coordinations.created_by_user_id is '作成者（app_users.id）。移行前の行はnull';
comment on column public.coordination_responses.participant_user_id is '回答者本人（app_users.id）。移行前の行・アカウントの無い人の代理登録はnull';
comment on column public.coordination_responses.registered_by_user_id is 'この回答を登録した人（app_users.id）。移行前の行はnull';
comment on column public.equipment.updated_by_user_id is '最終更新者（app_users.id）。移行前の行はnull';
comment on column public.equipment_history.moved_by_user_id is '移動者（app_users.id）。移行前の行はnull';

create index if not exists idx_events_poster_user_id on public.events (poster_user_id);
create index if not exists idx_participants_participant_user_id on public.participants (participant_user_id);
create index if not exists idx_participants_registered_by_user_id on public.participants (registered_by_user_id);
create index if not exists idx_coordinations_created_by_user_id on public.coordinations (created_by_user_id);
create index if not exists idx_coordination_responses_participant_user_id on public.coordination_responses (participant_user_id);
create index if not exists idx_coordination_responses_registered_by_user_id on public.coordination_responses (registered_by_user_id);
create index if not exists idx_equipment_updated_by_user_id on public.equipment (updated_by_user_id);
create index if not exists idx_equipment_history_moved_by_user_id on public.equipment_history (moved_by_user_id);

commit;
