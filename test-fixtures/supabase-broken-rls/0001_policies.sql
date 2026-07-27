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

create table public.orders (
  id uuid primary key,
  user_id uuid,
  total numeric
);

alter table public.orders enable row level security;

-- BROKEN: `using (true)` disables all row filtering — every row is world-readable.
create policy "orders open to all"
  on public.orders
  for select
  using (true);

-- BROKEN: a view defaults to SECURITY DEFINER, so it can leak rows RLS would hide.
create view public.customer_emails as
  select email, card_last4 from public.customers;
