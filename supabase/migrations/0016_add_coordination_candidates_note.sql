-- coordination_candidates.note を追加（候補日時の補足。任意・50文字以内）
-- 例：「午前」「午後」「撮影日」など
-- 既存行のnoteはnullのまま（backfillしない）。列追加のみでUPDATEは行わないため、
-- 既存の候補行（date/time/sort_order等）には一切影響しない
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは今回は未反映。動作確認後にまとめて反映する）
-- 何度実行しても壊れないよう add column if not exists を使っている

begin;

alter table public.coordination_candidates
  add column if not exists note text
  constraint coordination_candidates_note_length_check check (note is null or char_length(note) <= 50);

comment on column public.coordination_candidates.note is '候補日時の補足（例：午前／午後／撮影日）。任意・50文字以内';

commit;
