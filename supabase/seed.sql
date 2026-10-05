-- Seed data. `supabase db reset` runs this automatically for local development.
-- For a hosted project, run the allowlist insert in the SQL editor with real addresses.
-- Placeholder only — never commit real production emails.

insert into public.allowed_emails (email, note)
values ('owner@example.com', 'Placeholder — replace with a real Google account email')
on conflict (email) do nothing;
