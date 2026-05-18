-- Row-level security: every row is owned by user_id; users can only
-- read/write their own rows. profiles uses id directly.

alter table profiles enable row level security;
alter table workspaces enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table files enable row level security;
alter table resources enable row level security;
alter table artifacts enable row level security;
alter table notes enable row level security;

create policy "own profile" on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy "own workspaces" on workspaces
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own conversations" on conversations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own messages" on messages
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own files" on files
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own resources" on resources
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own artifacts" on artifacts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own notes" on notes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Auto-create a profile row when a new auth user is inserted.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
