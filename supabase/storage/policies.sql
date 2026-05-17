-- Storage bucket and policies for the user-files bucket.
-- Run this once after creating the project; bucket name must match the
-- value used by lib/uploadthing.ts / hooks/use-upload-file.ts when it
-- is migrated to Supabase Storage (Phase 1 follow-on).

-- Create the bucket (private by default; signed URLs only).
insert into storage.buckets (id, name, public)
values ('user-files', 'user-files', false)
on conflict (id) do nothing;

-- Users can read/write only under their own user_id prefix.
-- Path scheme: user-files/{auth.uid()}/{file_id}.{ext}
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
