-- 段階5 ④: 備品の画像の保存場所（Storage のバケット equipment-images）を非公開にする
--   ・バケットの public を true → false にするだけ。ファイル（items/<uuid>.<拡張子>）と DB の equipment.image_url は書き換えない
--   ・非公開にすると、公開URLの形（…/storage/v1/object/public/equipment-images/…）ではログインなしで画像が読めなくなる
--   ・画面（③で入れた js/equipment.js）は、API（POST /api/equipment?action=image_urls）が service_role で作る
--       期限付きURL（1時間）で表示しているので、そのまま表示できる
--   ・アップロード（api/equipment/upload-url.js の署名付きのアップロード用URL → 画面から uploadToSignedUrl）は、
--       非公開のバケットでも今までどおり使える。getPublicUrl は URL の文字列を組み立てるだけなので、
--       DB には今までと同じ公開URLの形が入る（③の isOwnImageUrl の確認もそのまま通る）
--   ・Storage（storage.objects）には読み取りのポリシーを足さない（期限付きURLは service_role で作るため不要）
--
-- 方針:
--   ・ファイル・DBの行は一切削除・上書きしない（storage.buckets の 1 行の public 列だけを変える）
--   ・バケットのほかの設定（容量の上限 5MB・画像の形式）は変えない
--   ・③より前の古い画面を開いたままの人は、画像が出なくなる（公開URLを直接使っているため）。
--       ページを読み直せば③の画面になり、期限付きURLで出る
--
-- 実行の結果（2026-10-02）:
--   ・07:13:08 UTC に実行（public = false）。キャッシュを通らない読み方（HEAD など）は、すぐに 400 になった
--   ・Supabase の Smart CDN（x-smart-cdn: true）にキャッシュされていた既存の18件は、09:00 UTC の時点でも
--       公開URLで読めた（CF-Cache-Status: HIT）。Smart CDN はファイルの変更・削除でキャッシュを消すが、
--       バケットを非公開にしただけでは消えない。キャッシュに無い画像（実行後にアップロードした画像）は 400
--
-- 実行方法: SupabaseダッシュボードのSQL Editorで、次の順に実行する
--   (0) 実行の前に、下の「記録用の SELECT」2つを実行し、結果を残す（貼り付けて保存）
--   (1) このファイルの begin; 〜 commit; を実行する
--   (2) 最後の「確認用の SELECT」を実行し、public が false になったことを確かめる
-- 何度実行しても壊れない（すでに非公開なら何も変えずに終わる）
--
-- ============================================================
-- 記録用の SELECT（変える前に実行して、結果を残す）
-- ============================================================
-- select id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at
--   from storage.buckets
--  order by id;
--
-- select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
--   from pg_policies
--  where schemaname = 'storage'
--  order by tablename, policyname;
--
-- 2026-10-02 の実行前の記録:
--   storage.buckets は equipment-images の1行だけ（public = true、file_size_limit = 5242880、
--     allowed_mime_types = {image/png,image/jpeg,image/webp,image/gif}、created_at・updated_at = 2026-08-12 15:23:21.789632+00）
--   storage のポリシーは 0 行
--
-- ============================================================
-- 元に戻すSQL（公開に戻す。ファイル・DBはそのままなので、これだけで元の状態に戻る）
-- ============================================================
-- update storage.buckets set public = true where id = 'equipment-images';

begin;

do $$
declare
  v_public boolean;
begin
  select public into v_public from storage.buckets where id = 'equipment-images';
  if not found then
    raise exception 'バケット equipment-images が見つかりません。何も変えずに止めました';
  end if;
  if v_public = false then
    raise notice 'バケット equipment-images はすでに非公開です。何も変えません';
  end if;
end
$$;

update storage.buckets
   set public = false,
       updated_at = now()
 where id = 'equipment-images'
   and public = true;

commit;

-- ============================================================
-- 確認用の SELECT（実行のあと）
-- ============================================================
-- select id, public, file_size_limit, allowed_mime_types, updated_at
--   from storage.buckets
--  where id = 'equipment-images';
--   → public = false、file_size_limit = 5242880、allowed_mime_types = {image/png,image/jpeg,image/webp,image/gif}
