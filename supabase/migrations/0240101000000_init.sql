-- =========================================================
-- 0001_init.sql — RecallStack foundational schema
-- =========================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";

-- ---------- Helper: updated_at trigger ----------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- =========================================================
-- USERS (profile extension; auth.users is managed by Supabase)
-- =========================================================
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  timezone     text not null default 'UTC',          -- (fix #3) for "due today"
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function set_updated_at();

alter table public.profiles enable row level security;

create policy "profile_self_select" on public.profiles
  for select using (auth.uid() = id);
create policy "profile_self_update" on public.profiles
  for update using (auth.uid() = id);

-- Auto-create a profile on signup
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- =========================================================
-- DECKS
-- =========================================================
create table public.decks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 100),
  description  text check (char_length(description) <= 1000),
  card_count   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index decks_user_id_idx on public.decks(user_id);

create trigger decks_updated_at before update on public.decks
  for each row execute function set_updated_at();

alter table public.decks enable row level security;

create policy "decks_owner_all" on public.decks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =========================================================
-- CARDS
-- =========================================================
create table public.cards (
  id            uuid primary key default gen_random_uuid(),
  deck_id       uuid not null references public.decks(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,  -- (fix #4) denormalized for indexing
  front         text not null check (char_length(front) between 1 and 10000),
  back          text not null check (char_length(back) between 1 and 10000),
  front_rich    jsonb,
  back_rich     jsonb,
  -- FSRS state
  stability     real not null default 0,
  difficulty    real not null default 0,
  due           timestamptz not null default now(),
  state         smallint not null default 0 check (state between 0 and 3),
  reps          integer not null default 0,
  lapses        integer not null default 0,
  tags          text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- (fix #4) Composite indexes for the hot path
create index cards_user_due_idx  on public.cards(user_id, due) where state <> 3;
create index cards_deck_due_idx  on public.cards(deck_id, due);
create index cards_tags_gin      on public.cards using gin(tags);

create trigger cards_updated_at before update on public.cards
  for each row execute function set_updated_at();

alter table public.cards enable row level security;

create policy "cards_owner_all" on public.cards
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- (fix #6) card_count denormalization via trigger, not app code
create or replace function bump_deck_card_count()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update public.decks set card_count = card_count + 1 where id = new.deck_id;
  elsif tg_op = 'DELETE' then
    update public.decks set card_count = card_count - 1 where id = old.deck_id;
  elsif tg_op = 'UPDATE' and new.deck_id <> old.deck_id then
    update public.decks set card_count = card_count - 1 where id = old.deck_id;
    update public.decks set card_count = card_count + 1 where id = new.deck_id;
  end if;
  return null;
end $$;

create trigger cards_count_trigger
  after insert or update or delete on public.cards
  for each row execute function bump_deck_card_count();

-- =========================================================
-- REVIEW LOGS — survive card deletion (fix #5)
-- =========================================================
create table public.review_logs (
  id                uuid primary key default gen_random_uuid(),
  -- Client-supplied idempotency key for offline replay (fix #7)
  client_review_id  uuid not null,
  card_id           uuid references public.cards(id) on delete set null,
  deck_id           uuid references public.decks(id) on delete set null,
  user_id           uuid not null references auth.users(id) on delete cascade,
  rating            smallint not null check (rating between 1 and 4),
  review_time       timestamptz not null default now(),
  elapsed_days      real not null,
  scheduled_days    real not null,
  state             smallint not null,
  duration_ms       integer check (duration_ms >= 0)
);

-- Per-user dedupe: same client_review_id can't apply twice
create unique index review_logs_idem_idx on public.review_logs(user_id, client_review_id);
create index review_logs_user_time_idx   on public.review_logs(user_id, review_time desc);

alter table public.review_logs enable row level security;

create policy "review_logs_owner_select" on public.review_logs
  for select using (auth.uid() = user_id);
create policy "review_logs_owner_insert" on public.review_logs
  for insert with check (auth.uid() = user_id);
-- Note: no update/delete policy. Logs are immutable.

-- =========================================================
-- SUBSCRIPTIONS
-- =========================================================
create table public.subscriptions (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id       text unique,
  stripe_subscription_id   text unique,
  plan                     text not null default 'free' check (plan in ('free','pro')),
  status                   text not null default 'active' check (status in ('active','cancelled','expired','past_due')),
  is_lifetime              boolean not null default false,
  current_period_end       timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function set_updated_at();

alter table public.subscriptions enable row level security;

-- Users can READ their own subscription; writes happen via service role only.
create policy "subs_owner_select" on public.subscriptions
  for select using (auth.uid() = user_id);

-- =========================================================
-- STRIPE WEBHOOK IDEMPOTENCY (fix #1) — critical, missing from doc
-- =========================================================
create table public.webhook_events (
  event_id    text primary key,            -- Stripe's evt_...
  type        text not null,
  received_at timestamptz not null default now(),
  payload     jsonb not null
);
-- No RLS needed: only service role writes/reads this table.
alter table public.webhook_events enable row level security;

-- =========================================================
-- AI USAGE COUNTER (fix #2) — critical, missing from doc
-- =========================================================
create table public.ai_usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  year_month  text not null,               -- 'YYYY-MM' in user's local time
  count       integer not null default 0,
  primary key (user_id, year_month)
);

alter table public.ai_usage enable row level security;
create policy "ai_usage_owner_select" on public.ai_usage
  for select using (auth.uid() = user_id);
-- Writes happen via service role from the /api/generate endpoint
-- (after auth + tier check). No insert/update policy for end users.