-- 備品画像用のStorageバケットを作成
-- 支部の区別なく全体で1つの備品リストを共有するため、バケットも1つのみ。
-- publicバケットなので画像の読み取り(GET /storage/v1/object/public/...)はRLS不要で誰でも可能。
-- アップロード/削除はanonキーにはRLSでブロックされ、api/*.js からservice role keyで行う
-- （service roleはRLSをバイパスするため専用ポリシーは不要）。
--
-- 備考: このバケットは実運用プロジェクトに対してSupabase管理APIから直接作成済み。
-- このSQLは新規プロジェクトを一から構築する場合の再現用ドキュメント。
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'equipment-images',
  'equipment-images',
  true,
  5242880, -- 5MB
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;
