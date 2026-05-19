-- Closes the last Step 2 item: guarantee a review log's user_id cannot
-- diverge from the owner of the deck it references. Mirrors the cards fix,
-- but tuned so review history still survives card/deck deletion.

-- 1. Clean any pre-existing drift before the constraint is applied.
delete from public.review_logs rl
where rl.deck_id is not null
  and not exists (
    select 1 from public.decks d
    where d.id = rl.deck_id
      and d.user_id = rl.user_id
  );

-- 2. Ensure deck_id nulls out (not cascades) if a deck is deleted.
--    Drop the implicit FK created by the original table definition first.
alter table public.review_logs
  drop constraint if exists review_logs_deck_id_fkey;

alter table public.review_logs
  add constraint review_logs_deck_id_fkey
  foreign key (deck_id) references public.decks(id)
  on delete set null;

-- 3. The composite FK: a log's (deck_id, user_id) must be a real
--    (deck, owner) pair. ON DELETE SET NULL (deck_id) nulls only the deck
--    column — user_id is NOT NULL and must survive deck deletion.
--    NOT VALID + VALIDATE avoids a long table lock on a large log table.
alter table public.review_logs
  add constraint review_logs_deck_owner_fk
  foreign key (deck_id, user_id)
  references public.decks(id, user_id)
  on delete set null (deck_id)
  not valid;

alter table public.review_logs
  validate constraint review_logs_deck_owner_fk;
