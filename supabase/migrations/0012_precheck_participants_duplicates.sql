-- 【事前チェック用・SELECTのみ】0012_extend_participants_status_comment.sql の適用前に実行する
-- (event_id, participant_name) が重複している行を洗い出す。
-- ユニーク制約の追加は重複があると失敗するため、1件でも出た場合は先に整理すること。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- このファイルはデータを一切変更しない（SELECTのみ）

-- (1) 重複している行の一覧
--     dup_count >= 2 のグループについて、全行の id / created_at を表示する。
--     participant_name は完全一致（trim・全角半角の正規化はしていない）で比較する。
select
  p.event_id,
  p.participant_name,
  p.id,
  p.created_at,
  count(*) over (partition by p.event_id, p.participant_name) as dup_count
from public.participants p
where (p.event_id, p.participant_name) in (
  select event_id, participant_name
  from public.participants
  group by event_id, participant_name
  having count(*) > 1
)
order by p.event_id, p.participant_name, p.created_at;

-- (2) 重複グループの件数と、余分な行（各グループで1件を残した場合の削除対象数）
select
  count(*)                        as duplicate_groups,
  coalesce(sum(cnt - 1), 0)       as extra_rows
from (
  select count(*) as cnt
  from public.participants
  group by event_id, participant_name
  having count(*) > 1
) d;
