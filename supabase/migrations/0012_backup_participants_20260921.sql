-- participants のバックアップ（0012_extend_participants_status_comment.sql の適用前に実行する）
-- participants を participants_backup_20260921 として丸ごと複製し、件数・内容が一致することを確認する。
--
-- 実行順: 0012_precheck_participants_duplicates.sql → このファイル → 0012_extend_participants_status_comment.sql
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
--
-- 方針:
--   ・元テーブル participants には一切変更を加えない（読み取りのみ）
--   ・同名のバックアップテーブルが既にある場合は create table がエラーになり、そこで止まる
--     （IF NOT EXISTS も DROP もしない = 上書きしない）
--   ・件数または内容が一致しない場合は例外を出してロールバックする（不完全なバックアップを残さない）
--   ・バックアップテーブルはRLSを有効化しポリシーを作らない = anon/authenticated からは読めない
--     （publicスキーマのテーブルはデフォルトでPostgREST経由で見えてしまうため）
--     Realtimeのpublicationにも追加しない
--   ・create table ... as は列とデータのみ複製し、制約・インデックスは複製しない（退避用途のため）

begin;

-- 1. 丸ごと複製（既存なら「relation already exists」エラーで停止）
create table public.participants_backup_20260921 as
  table public.participants;

alter table public.participants_backup_20260921 enable row level security;

comment on table public.participants_backup_20260921 is 'participants の退避コピー（2026-09-21 / 参加/不参加・コメント拡張マイグレーション前）';

-- 2. 件数・内容の一致を検証（不一致なら例外→ロールバック）
do $$
declare
  original_count bigint;
  backup_count   bigint;
  only_original  bigint;
  only_backup    bigint;
begin
  select count(*) into original_count from public.participants;
  select count(*) into backup_count   from public.participants_backup_20260921;

  select count(*) into only_original from (
    select * from public.participants
    except
    select * from public.participants_backup_20260921
  ) d1;

  select count(*) into only_backup from (
    select * from public.participants_backup_20260921
    except
    select * from public.participants
  ) d2;

  if original_count <> backup_count or only_original <> 0 or only_backup <> 0 then
    raise exception 'バックアップが元テーブルと一致しません（元=%, バックアップ=%, 元のみ=%, バックアップのみ=%）',
      original_count, backup_count, only_original, only_backup;
  end if;
end
$$;

-- 3. 比較結果の表示（match が true ならOK）
select
  (select count(*) from public.participants)                  as original_count,
  (select count(*) from public.participants_backup_20260921)  as backup_count,
  (select count(*) from public.participants)
    = (select count(*) from public.participants_backup_20260921) as match;

commit;

-- 参考: コミット後にもう一度確認したい場合（読み取りのみ）
-- select
--   (select count(*) from public.participants)                  as original_count,
--   (select count(*) from public.participants_backup_20260921)  as backup_count;
