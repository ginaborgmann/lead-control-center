create table public.follow_up_adviser_notes (
  reonic_user_id text primary key,
  note text not null check (char_length(note) <= 4000),
  updated_at timestamptz not null default now()
);
alter table public.follow_up_adviser_notes enable row level security;
revoke all on public.follow_up_adviser_notes from public,anon,authenticated;
grant select,insert,update on public.follow_up_adviser_notes to authenticated;
create policy "Admins manage adviser notes" on public.follow_up_adviser_notes
for all to authenticated using ((select public.is_app_admin())) with check ((select public.is_app_admin()));