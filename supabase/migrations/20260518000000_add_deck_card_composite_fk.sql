-- Adds the composite unique key on decks and the FK on cards that prevents a
-- user from attaching a card to another user's deck even when their own user_id
-- satisfies the RLS WITH CHECK. Required for the "smuggle" RLS test to pass.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'decks_id_user_key'
      AND conrelid = 'public.decks'::regclass
  ) THEN
    ALTER TABLE public.decks ADD CONSTRAINT decks_id_user_key UNIQUE (id, user_id);
  END IF;
END $$;

-- Remove orphaned cards whose (deck_id, user_id) pair has no matching deck row.
-- These are leftovers from test runs before the FK existed.
DELETE FROM public.cards c
WHERE NOT EXISTS (
  SELECT 1 FROM public.decks d
  WHERE d.id = c.deck_id AND d.user_id = c.user_id
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cards_deck_owner_fk'
      AND conrelid = 'public.cards'::regclass
  ) THEN
    ALTER TABLE public.cards
      ADD CONSTRAINT cards_deck_owner_fk
      FOREIGN KEY (deck_id, user_id)
      REFERENCES public.decks(id, user_id)
      ON DELETE CASCADE;
  END IF;
END $$;
