-- ============================================================
-- migration 0028: お知らせ（アプリ内のお知らせ一覧）と、種類ごとのオンオフ（お知らせ機能の段階1）
-- ============================================================
-- 内容:
--   ・notifications: 1人1行のお知らせ。API（service_role）だけが作る・既読にする。本人だけが読める（0027 と同じ形の RLS）
--   ・notification_settings: 種類ごとのオンオフ（5つ）。行が無い人はすべて ON。API だけが書く。本人だけが読める
--
-- 方針:
--   ・既存の表・ポリシーは変えない（追加だけ）
--   ・user_id は app_users を on delete cascade で参照する。お知らせ・設定は本人の持ち物で「記録」ではないため、
--     ユーザー管理の「削除」（記録が無い人だけ）を止めない
--   ・event_id・coordination_id は外部キーにしない（予定が消えたあとも「削除されました」のお知らせを残すため）
--   ・Realtime には入れない（未読数は、ページを開いたとき・タブに戻ったとき・一覧を開いたときだけ読む。転送量を増やさないため。
--     Realtime の削除は RLS で絞られず、ほかの人に id が届くため、という理由もある）
--   ・同じお知らせを2つ作らないよう、(user_id, dedupe_key) を一意にする（段階3の Cron が2回動いても1つ）
--
-- 実行方法: SupabaseダッシュボードのSQL Editorで、次の順に実行する
--   (0) 実行の前に、下の「記録用の SELECT」を実行し、結果を残す
--   (1) このファイルの begin; 〜 commit; を実行する
--   (2) 最後の「確認用の SELECT」を実行する
-- 何度実行しても壊れない（if not exists / drop policy if exists → create policy）
--
-- 戻すとき（お知らせと設定はすべて消える）:
-- -- drop table if exists public.notifications;
-- -- drop table if exists public.notification_settings;
-- ============================================================
-- 記録用の SELECT（変える前に実行して、結果を残す）
-- ============================================================
-- select schemaname, tablename, policyname, roles, cmd
--   from pg_policies where schemaname = 'public' order by tablename, policyname;
-- select to_regclass('public.notifications') as notifications,
--        to_regclass('public.notification_settings') as notification_settings;   -- 両方 null のはず
-- select count(*) as active_users from public.app_users where status = 'active';
-- select proname, prosecdef from pg_proc where proname = 'is_active_user';      -- 1行・prosecdef = true のはず

begin;

create table if not exists public.notifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.app_users (id) on delete cascade,
  kind             text not null
                     constraint notifications_kind_check check (kind in (
                       'event_reminder', 'event_created', 'coordination_created',
                       'coordination_decided', 'event_changed', 'event_deleted'
                     )),
  title            text not null constraint notifications_title_length check (char_length(title) between 1 and 100),
  body             text not null default '' constraint notifications_body_length check (char_length(body) <= 300),
  url              text,
  event_id         uuid,
  coordination_id  uuid,
  dedupe_key       text not null,
  created_at       timestamptz not null default now(),
  read_at          timestamptz,
  constraint notifications_user_id_dedupe_key_key unique (user_id, dedupe_key)
);

comment on table public.notifications is 'お知らせ（1人1行）。API（service_role）だけが作る。本人だけが読める。60日で消す（段階3の Cron）';
comment on column public.notifications.kind is
  'event_reminder=①前日の予告 / event_created=②予定の立ち上げ / coordination_created=③日程調整の立ち上げ / coordination_decided=④決定 / event_changed・event_deleted=⑤参加した予定の変更・削除';
comment on column public.notifications.url is '押したときに開く画面（index.html?event=… / coordination.html?id=…）。null なら移動しない';
comment on column public.notifications.dedupe_key is '同じお知らせを2つ作らないための鍵（例: event_created:<予定のid>）。user_id と組で一意';
comment on column public.notifications.read_at is '既読にした日時（未読は null）';

create index if not exists idx_notifications_user_id_created_at on public.notifications (user_id, created_at desc);
create index if not exists idx_notifications_user_id_unread on public.notifications (user_id) where read_at is null;
create index if not exists idx_notifications_created_at on public.notifications (created_at); -- 60日の掃除（段階3）

create table if not exists public.notification_settings (
  user_id               uuid primary key references public.app_users (id) on delete cascade,
  event_reminder        boolean not null default true,
  event_created         boolean not null default true,
  coordination_created  boolean not null default true,
  coordination_decided  boolean not null default true,
  event_changed         boolean not null default true,
  updated_at            timestamptz not null default now()
);

comment on table public.notification_settings is 'お知らせの種類ごとのオンオフ。行が無い人はすべて ON。OFF の種類はお知らせの行も作らない';
comment on column public.notification_settings.event_changed is '⑤参加した予定の変更・削除（両方をこの1つで切り替える）';

alter table public.notifications enable row level security;
alter table public.notification_settings enable row level security;

-- 読み取りだけを authenticated に許す（中身はポリシーで本人の行だけ）。書き込みは service_role（API）だけ
revoke all on table public.notifications from anon;
revoke all on table public.notification_settings from anon;
revoke insert, update, delete, truncate, references, trigger on table public.notifications from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.notification_settings from authenticated;
grant select on table public.notifications to authenticated;
grant select on table public.notification_settings to authenticated;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select to authenticated
  using ((select public.is_active_user()) and user_id = (select auth.uid()));

drop policy if exists "notification_settings_select_own" on public.notification_settings;
create policy "notification_settings_select_own" on public.notification_settings
  for select to authenticated
  using ((select public.is_active_user()) and user_id = (select auth.uid()));

commit;

-- ============================================================
-- 確認用の SELECT（実行したあとに）
-- ============================================================
-- select tablename, policyname, roles, cmd, qual from pg_policies
--  where tablename in ('notifications', 'notification_settings') order by tablename;   -- 2行・{authenticated}・SELECT
-- select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname in ('notifications', 'notification_settings');  -- 両方 true
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and table_name in ('notifications', 'notification_settings')
--    and grantee in ('anon', 'authenticated') order by grantee, table_name, privilege_type;  -- authenticated の SELECT だけ（2行）
-- select pubname, tablename from pg_publication_tables
--  where tablename in ('notifications', 'notification_settings');                     -- 0行（Realtime に入っていない）
-- select (select count(*) from public.notifications) as notifications,
--        (select count(*) from public.notification_settings) as settings;            -- 0, 0
-- select count(*) from pg_policies where schemaname = 'public';                       -- 記録用の SELECT の行数＋2
