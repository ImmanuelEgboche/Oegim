import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Service-role client: bypasses RLS. review_logs has no end-user INSERT policy
// (only the apply_review function writes there), so seeding and the FK-integrity
// checks below MUST go through this client. RLS is exercised only by the read test.
const admin = createClient(URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function signInAs(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

// Insert a deck + card owned by the given user. Returns both ids.
async function seedDeckAndCard(userId: string, deckName: string) {
  const { data: deck, error: dErr } = await admin
    .from('decks').insert({ user_id: userId, name: deckName })
    .select('id').single()
  if (dErr || !deck) throw dErr

  const { data: card, error: cErr } = await admin
    .from('cards')
    .insert({ deck_id: deck.id, user_id: userId, front: 'q', back: 'a' })
    .select('id').single()
  if (cErr || !card) throw cErr

  return { deckId: deck.id as string, cardId: card.id as string }
}

// A valid review_logs row for a given card/deck/owner.
function logRow(o: { cardId: string; deckId: string; userId: string }) {
  return {
    client_review_id: crypto.randomUUID(),
    card_id: o.cardId,
    deck_id: o.deckId,
    user_id: o.userId,
    rating: 3,
    elapsed_days: 0,
    scheduled_days: 1,
    state: 1,
    duration_ms: 4200,
  }
}

describe('review_logs: ownership integrity and isolation', () => {
  const ts = Date.now()
  const emailA = `rl-a-${ts}@test.invalid`
  const emailB = `rl-b-${ts}@test.invalid`
  const password = 'Rls-Test-Pass-1!'

  let userAId: string
  let userBId: string
  let clientA: SupabaseClient

  beforeAll(async () => {
    const { data: a, error: errA } = await admin.auth.admin.createUser({
      email: emailA, password, email_confirm: true,
    })
    if (errA || !a.user) throw errA
    userAId = a.user.id

    const { data: b, error: errB } = await admin.auth.admin.createUser({
      email: emailB, password, email_confirm: true,
    })
    if (errB || !b.user) throw errB
    userBId = b.user.id

    clientA = await signInAs(emailA, password)
  })

  afterAll(async () => {
    if (userAId) await admin.auth.admin.deleteUser(userAId)
    if (userBId) await admin.auth.admin.deleteUser(userBId)
  })

  // ----------------------------------------------- COMPOSITE FK INTEGRITY ---

  it("a log cannot be inserted with A as owner but B's deck — composite FK rejects it", async () => {
    const b = await seedDeckAndCard(userBId, 'B deck (smuggle target)')
    // user_id = A, deck_id = B's deck: satisfies nothing real. The composite FK
    // (deck_id, user_id) -> decks(id, user_id) must reject this.
    const { error } = await admin.from('review_logs').insert(
      logRow({ cardId: b.cardId, deckId: b.deckId, userId: userAId }),
    ).select('id')
    expect(error).not.toBeNull()
  })

  it('a log CAN be inserted for a matching deck/owner pair — positive write case', async () => {
    const b = await seedDeckAndCard(userBId, 'B deck (legit log)')
    const { data, error } = await admin.from('review_logs').insert(
      logRow({ cardId: b.cardId, deckId: b.deckId, userId: userBId }),
    ).select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  // ------------------------------------------- HISTORY SURVIVES DELETION ---

  it('a review log survives DECK deletion: deck_id nulled, user_id intact', async () => {
    const b = await seedDeckAndCard(userBId, 'B deck (to be deleted)')
    const { data: log } = await admin.from('review_logs').insert(
      logRow({ cardId: b.cardId, deckId: b.deckId, userId: userBId }),
    ).select('id').single()

    // Deleting the deck cascades to its card; the log itself must remain.
    const { error: delErr } = await admin.from('decks').delete().eq('id', b.deckId)
    expect(delErr).toBeNull()

    const { data: after, error } = await admin
      .from('review_logs')
      .select('id, deck_id, card_id, user_id')
      .eq('id', log!.id)
      .single()

    expect(error).toBeNull()
    expect(after).not.toBeNull()
    expect(after!.deck_id).toBeNull()        // ON DELETE SET NULL (deck_id)
    expect(after!.user_id).toBe(userBId)     // user_id must NOT be nulled
  })

  it('a review log survives CARD deletion: card_id nulled, user_id and deck_id intact', async () => {
    const b = await seedDeckAndCard(userBId, 'B deck (card deleted)')
    const { data: log } = await admin.from('review_logs').insert(
      logRow({ cardId: b.cardId, deckId: b.deckId, userId: userBId }),
    ).select('id').single()

    const { error: delErr } = await admin.from('cards').delete().eq('id', b.cardId)
    expect(delErr).toBeNull()

    const { data: after, error } = await admin
      .from('review_logs')
      .select('id, deck_id, card_id, user_id')
      .eq('id', log!.id)
      .single()

    expect(error).toBeNull()
    expect(after).not.toBeNull()
    expect(after!.card_id).toBeNull()        // ON DELETE SET NULL on card_id
    expect(after!.deck_id).toBe(b.deckId)    // deck reference untouched
    expect(after!.user_id).toBe(userBId)
  })

  // ---------------------------------------------------------------- RLS ---

  it("A cannot read B's review logs — RLS filters them out", async () => {
    const b = await seedDeckAndCard(userBId, 'B deck (private logs)')
    const { data: log } = await admin.from('review_logs').insert(
      logRow({ cardId: b.cardId, deckId: b.deckId, userId: userBId }),
    ).select('id').single()

    const { data, error } = await clientA
      .from('review_logs').select('id').eq('id', log!.id)

    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })
})