-- participants.registered_by を追加（代理登録に対応するため「操作した人」の名前を記録する）
-- participant_name : 参加/不参加の対象となる人の名前（従来どおり）
-- registered_by    : その行を最初に登録した人の名前。本人が登録した場合は participant_name と同じ値になる
--                    既存行は NULL のまま（backfillしない）。NULL は「登録者不明（本人登録として扱う）」を意味する
--
-- CHECK制約: NULL または「前後に空白なし・1〜50文字」。
--   （participant_name 側にはNOT NULL以外の制約が無いため、合わせる対象は無い。
--     新規列としてAPI/フロントの入力上限に合わせた50文字を採用する）
--   trim対象は半角スペース・タブ・改行・全角スペース（APIの String#trim と同じ範囲）
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは今回は未反映。全マイグレーション完了後にまとめて反映する）
-- 何度実行しても壊れないよう add column if not exists を使っている
-- 既存行の削除・更新は一切行わない（デフォルト値なしの列追加のみのため、既存行は書き換わらない）

begin;

alter table public.participants
  add column if not exists registered_by text
  constraint participants_registered_by_check check (
    registered_by is null
    or (
      registered_by = btrim(registered_by, E' \t\r\n　')
      and char_length(registered_by) between 1 and 50
    )
  );

comment on column public.participants.registered_by is 'この参加登録を最初に行った人の名前（代理登録対応）。NULL=従来データ（本人登録として扱う）';

commit;
