-- Finding 13 (database audit 2026-11-01): the avatars and logos buckets are public, so direct object URLs
-- (/storage/v1/object/public/<bucket>/<name>) keep working without any SELECT policy on storage.objects.
-- These two policies only added one thing: anyone with the public anon key could LIST every file name in the bucket
-- through the Storage list API (customer company names in logo file names, employee photos).
-- Uploads go through the storage-upload edge function (service role), which does not need them either.
--
-- ROLLBACK:
--   create policy "Public read avatars" on storage.objects for select to public using (bucket_id = 'avatars');
--   create policy "Public read logos"   on storage.objects for select to public using (bucket_id = 'logos');

drop policy if exists "Public read avatars" on storage.objects;
drop policy if exists "Public read logos"   on storage.objects;
