-- participants に参加/不参加(status)と個別コメント(comment)を追加
-- status : 'going'（参加） / 'not_going'（不参加）の2値。既存行は全て 'going' になる
-- comment: 任意。200文字以内
-- あわせて (event_id, participant_name) のユニーク制約を追加し、同名の二重登録を防ぐ。
-- REPLICA IDENTITY FULL は、Realtime の DELETE/UPDATE イベントの payload.old に
-- event_id 等の全カラムを載せるため（デフォルトでは主キーしか入らない）。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- 事前に 0012_precheck_participants_duplicates.sql で重複が0件であることを確認すること。
-- （重複が残っている場合はユニーク制約の手前で例外を出し、トランザクション全体をロールバックする）
-- （supabase/schema.sqlは今回は未反映。全マイグレーション完了後にまとめて反映する）
-- 何度実行しても壊れないよう、IF NOT EXISTS / 存在チェックを使っている

begin;

-- 1. status 列（'going' / 'not_going' のみ、NOT NULL、デフォルト 'going'）
--    列が既に存在する場合は制約ごとスキップされる
alter table public.participants
  add column if not exists status text not null default 'going'
  constraint participants_status_check check (status in ('going', 'not_going'));

comment on column public.participants.status is '参加区分: going=参加 / not_going=不参加';

-- 2. comment 列（NULL許可、200文字以内）
alter table public.participants
  add column if not exists comment text
  constraint participants_comment_length_check check (comment is null or char_length(comment) <= 200);

comment on column public.participants.comment is '参加者ごとの個別コメント（任意・200文字以内）';

-- 3. (event_id, participant_name) のユニーク制約
--    ADD CONSTRAINT には IF NOT EXISTS がないため、存在チェック付きのDOブロックで実行する
do $$
begin
  if exists (
    select 1
    from public.participants
    group by event_id, participant_name
    having count(*) > 1
  ) then
    raise exception '(event_id, participant_name) の重複行が残っています。0012_precheck_participants_duplicates.sql で確認し、整理してから再実行してください';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.participants'::regclass
      and conname = 'participants_event_id_participant_name_key'
  ) then
    alter table public.participants
      add constraint participants_event_id_participant_name_key
      unique (event_id, participant_name);
  end if;
end
$$;

-- 4. Realtime で UPDATE/DELETE の old 側に全カラムを載せる（何度実行しても同じ結果）
alter table public.participants replica identity full;

commit;
