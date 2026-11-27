-- The account's chat backend (wave 11 of PLAN-frontend-backend-split, Q111).
--
-- The browser's backend choice ("agent-py (runs)", the Next.js route, …)
-- follows a signed-in user across browsers: read on sign-in like
-- `memory_enabled` (a set value wins), written through on every change.
-- NULL = never chosen: the deploy's default applies (Q110). The four values
-- are the browser's `ChatBackend`; agent-py doesn't read or enforce it.
--
-- `profiles` already has own-row RLS ("own profile": id = auth.uid()) and no
-- column grants, so the owner can read and write it and no one else can.
alter table profiles
  add column if not exists chat_backend text
    check (chat_backend in ('ts', 'python', 'ts-service', 'python-runs'));
