-- 20260519093000_apply_review_rpc.sql
-- Step 3: the apply_review RPC — the atomic core of the review loop.
--
-- Updates a card's FSRS state AND records the review as ONE transaction:
-- both commit, or — on any error — both roll back. The API route computes
-- the FSRS result with ts-fsrs and passes the finished values in; this
-- function's job is to persist them atomically, enforce ownership,
-- validate the input, and stay idempotent when a review is replayed.

-- ---------------------------------------------------------------------------
-- 1. review_logs records the due date each review scheduled, so an idempotent
--    replay can return the original outcome exactly. Nullable column add;
--    apply_review always populates it for every row it writes.
-- ---------------------------------------------------------------------------
alter table public.review_logs
  add column if not exists scheduled_due timestamptz;

comment on column public.review_logs.scheduled_due is
  'The next-review date this review scheduled. Always set by apply_review.';

-- ---------------------------------------------------------------------------
-- 2. review_logs is written ONLY by apply_review (a SECURITY DEFINER
--    function). Remove any direct end-user INSERT path so log rows cannot be
--    forged — every log entry now has a single, trusted origin.
-- ---------------------------------------------------------------------------
drop policy if exists "review_logs_owner_insert" on public.review_logs;

-- ---------------------------------------------------------------------------
-- 3. The function.
-- ---------------------------------------------------------------------------
create or replace function public.apply_review(
  p_client_review_id  uuid,
  p_card_id           uuid,
  p_rating            smallint,
  p_stability         real,
  p_difficulty        real,
  p_due               timestamptz,
  p_state             smallint,
  p_reps              integer,
  p_lapses            integer,
  p_elapsed_days      real,
  p_scheduled_days    real,
  p_duration_ms       integer default null
)
returns table (applied boolean, next_due timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_card     public.cards%rowtype;
  v_existing public.review_logs%rowtype;
begin
  --------------------------------------------------------------------------
  -- 0. Authentication. SECURITY DEFINER bypasses RLS, so the function must
  --    establish identity itself. auth.uid() reads the caller's JWT and is
  --    null for an unauthenticated (or service-role) caller.
  --------------------------------------------------------------------------
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  --------------------------------------------------------------------------
  -- 1. Idempotency. Checked BEFORE input validation so that a replay of an
  --    "Again" review — whose scheduled_due is now in the past — is returned
  --    immediately without tripping the future-date guard below.
  --------------------------------------------------------------------------
  select * into v_existing
  from public.review_logs
  where user_id = v_uid
    and client_review_id = p_client_review_id;

  if found then
    return query select false, v_existing.scheduled_due;
    return;
  end if;

  --------------------------------------------------------------------------
  -- 2. Input validation — the function is the trust boundary. The API layer
  --    is trusted but not assumed correct: a bug in its FSRS mapping must
  --    fail loudly here, never corrupt a card's schedule silently.
  --------------------------------------------------------------------------
  if p_rating not between 1 and 4 then
    raise exception 'invalid rating: %', p_rating using errcode = '22023';
  end if;
  if p_state not between 0 and 3 then
    raise exception 'invalid card state: %', p_state using errcode = '22023';
  end if;
  if p_stability <= 0 then
    raise exception 'invalid stability: % (must be > 0)', p_stability
      using errcode = '22023';
  end if;
  if p_difficulty < 1 or p_difficulty > 10 then
    raise exception 'invalid difficulty: % (FSRS range is 1-10)', p_difficulty
      using errcode = '22023';
  end if;
  if p_reps < 0 or p_lapses < 0 then
    raise exception 'invalid reps/lapses: reps=%, lapses=%', p_reps, p_lapses
      using errcode = '22023';
  end if;
  -- Small tolerance: an "Again" rating schedules only minutes out, and minor
  -- clock skew between API server and database must not reject a valid date.
  if p_due is null or p_due <= now() - interval '1 minute' then
    raise exception 'invalid due date: % (must not be in the past)', p_due
      using errcode = '22023';
  end if;
  if p_duration_ms is not null and p_duration_ms < 0 then
    raise exception 'invalid duration_ms: %', p_duration_ms
      using errcode = '22023';
  end if;

  --------------------------------------------------------------------------
  -- 3. Ownership. Fetch the card and confirm the caller owns it. Defence in
  --    depth alongside RLS — and the reason user_id is derived from
  --    auth.uid() here, never accepted as a parameter the caller controls.
  --------------------------------------------------------------------------
  select * into v_card from public.cards where id = p_card_id;

  if not found then
    raise exception 'card not found: %', p_card_id using errcode = 'P0002';
  end if;
  if v_card.user_id <> v_uid then
    raise exception 'not authorised for card %', p_card_id
      using errcode = '42501';
  end if;

  --------------------------------------------------------------------------
  -- 4. The atomic write. The card's FSRS state and the review log are
  --    written together in this one function call's transaction.
  --------------------------------------------------------------------------
  update public.cards
  set stability  = p_stability,
      difficulty = p_difficulty,
      due        = p_due,
      state      = p_state,
      reps       = p_reps,
      lapses     = p_lapses,
      updated_at = now()
  where id = p_card_id;

  insert into public.review_logs (
    client_review_id, card_id, deck_id, user_id, rating,
    review_time, elapsed_days, scheduled_days, scheduled_due,
    state, duration_ms
  ) values (
    p_client_review_id, p_card_id, v_card.deck_id, v_uid, p_rating,
    now(), p_elapsed_days, p_scheduled_days, p_due,
    p_state, p_duration_ms
  );

  return query select true, p_due;
  return;

--------------------------------------------------------------------------
-- Concurrency. If two calls with the same client_review_id race, the unique
-- index review_logs(user_id, client_review_id) lets exactly one insert win.
-- The loser lands here — its card update is rolled back with the failed
-- insert, and it returns the same idempotent no-op as a sequential replay.
--------------------------------------------------------------------------
exception
  -- IMPORTANT: this handler assumes the ONLY unique constraint that can fire
  -- inside this block is review_logs(user_id, client_review_id). If a new
  -- unique constraint is added to cards or review_logs, this handler will
  -- catch those violations too and silently return (false, ...) — which would
  -- be wrong. Make the handler more specific if that happens.
  when unique_violation then
    select * into v_existing
    from public.review_logs
    where user_id = v_uid
      and client_review_id = p_client_review_id;
    return query select false, v_existing.scheduled_due;
    return;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Only authenticated users may call it; never anon.
-- ---------------------------------------------------------------------------
revoke all on function public.apply_review(
  uuid, uuid, smallint, real, real, timestamptz,
  smallint, integer, integer, real, real, integer
) from public;

grant execute on function public.apply_review(
  uuid, uuid, smallint, real, real, timestamptz,
  smallint, integer, integer, real, real, integer
) to authenticated;