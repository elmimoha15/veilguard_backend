-- Fixture: a Supabase project's schema + policies with broken RLS, as the
-- read-only connection would surface them. Used by the Slice-5 mock Supabase
-- connection so the white-box RLS rules fire on "real" policy content.

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text,
  card_last4 text
);

-- BROKEN: no `enable row level security` on public.customers → wide open via anon key.

create table public.invoices (
  id uuid primary key,
  owner uuid,
  amount numeric
);

alter table public.invoices enable row level security;

-- BROKEN: over-permissive — any logged-in user can read every invoice.
create policy "invoices readable by any authed user"
  on public.invoices
  for select
  using (auth.uid() is not null);
