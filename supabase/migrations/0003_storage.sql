-- The `user-files` Storage bucket and the per-user folder-prefix RLS
-- policies. Path scheme is `user-files/{auth.uid()}/{file_id}.{ext}`.
-- Read / write / update / delete are all scoped to the caller's own
-- folder.
--
-- Bucket is private; public reads happen via short-lived signed URLs
-- minted by the app (see hooks/use-upload-file.ts and lib/files/persist.ts).

insert into storage.buckets (id, name, public)
values ('user-files', 'user-files', false)
on conflict (id) do nothing;

create policy "user-files: own folder read" on storage.objects
  for select using (
    bucket_id = 'user-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "user-files: own folder write" on storage.objects
  for insert with check (
    bucket_id = 'user-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "user-files: own folder update" on storage.objects
  for update using (
    bucket_id = 'user-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "user-files: own folder delete" on storage.objects
  for delete using (
    bucket_id = 'user-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
