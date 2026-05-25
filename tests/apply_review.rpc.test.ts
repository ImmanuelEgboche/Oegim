import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Service-role client: bypasses RLS. Used for seeding decks/cards and for
// independently verifying card and log state after a call.
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

// Seed a deck + card owned by the given user. Returns the full seeded card.
async function seedCard(userId: string, deckName: string) {
  const { data: deck, error: dErr } = await admin
    .from('decks').insert({ user_id: userId, name: deckName })
    .select('id').single()
  if (dErr || !deck) throw dErr

  const { data: card, error: cErr } = await admin
    .from('cards')
    .insert({ deck_id: deck.id, user_id: userId, front: 'q', back: 'a' })
    .select('*').single()
  if (cErr || !card) throw cErr

  return { deckId: deck.id as string, card }
}

// A valid FSRS-result payload, as the API route would build it after running
// ts-fsrs. dueOffsetDays sets how far in the future the next review lands.
function reviewArgs(
  cardId: string,
  dueOffsetDays = 3,
  overrides: Record<string, unknown> = {},
) {
  return {
    p_client_review_id: randomUUID(),
    p_card_id: cardId,
    p_rating: 3,
    p_stability: 8.5,
    p_difficulty: 5.2,
    p_due: new Date(Date.now() + dueOffsetDays * 86_400_000).toISOString(),
    p_state: 2,
    p_reps: 1,
    p_lapses: 0,
    p_elapsed_days: 0,
    p_scheduled_days: dueOffsetDays,
    p_duration_ms: 4200,
    ...overrides,
  }
}

describe('apply_review: atomic review application', () => {
  const ts = Date.now()
  const emailA = `rpc-a-${ts}@test.invalid`
  const emailB = `rpc-b-${ts}@test.invalid`
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

  // ----------------------------------------------------------- NORMAL ---

  it('a normal review updates the card and writes exactly one log', async () => {
    const { card } = await seedCard(userAId, 'A deck (normal review)')
    const args = reviewArgs(card.id, 3)

    const { data, error } = await clientA.rpc('apply_review', args)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].applied).toBe(true)
    expect(new Date(data![0].next_due).getTime())
      .toBe(new Date(args.p_due).getTime())

    // The card's FSRS state was updated.
    const { data: updated } = await admin
      .from('cards').select('stability, state, reps, due')
      .eq('id', card.id).single()
    expect(updated!.stability).toBeCloseTo(8.5)
    expect(updated!.state).toBe(2)
    expect(updated!.reps).toBe(1)

    // Exactly one log row, recording this review.
    const { data: logs } = await admin
      .from('review_logs').select('rating, scheduled_due')
      .eq('card_id', card.id)
    expect(logs).toHaveLength(1)
    expect(logs![0].rating).toBe(3)
    expect(logs![0].scheduled_due).not.toBeNull()
  })

  // -------------------------------------------------------- IDEMPOTENT ---

  it('replaying the same client_review_id is a no-op returning the original due', async () => {
    const { card } = await seedCard(userAId, 'A deck (replay)')
    const args = reviewArgs(card.id, 5)

    const first = await clientA.rpc('apply_review', args)
    expect(first.error).toBeNull()
    expect(first.data![0].applied).toBe(true)

    // Same client_review_id again — e.g. an offline client retrying a review
    // it never received a response for.
    const second = await clientA.rpc('apply_review', args)
    expect(second.error).toBeNull()
    expect(second.data![0].applied).toBe(false)
    expect(new Date(second.data![0].next_due).getTime())
      .toBe(new Date(args.p_due).getTime())

    // Still exactly one log row — the review was not applied twice.
    const { data: logs } = await admin
      .from('review_logs').select('id').eq('card_id', card.id)
    expect(logs).toHaveLength(1)
  })

  it('a second, distinct review on the same card applies normally', async () => {
    const { card } = await seedCard(userAId, 'A deck (two reviews)')

    const r1 = await clientA.rpc('apply_review', reviewArgs(card.id, 2))
    expect(r1.error).toBeNull()
    expect(r1.data![0].applied).toBe(true)

    const r2 = await clientA.rpc('apply_review',
      reviewArgs(card.id, 9, { p_reps: 2 }))
    expect(r2.error).toBeNull()
    expect(r2.data![0].applied).toBe(true)

    const { data: logs } = await admin
      .from('review_logs').select('id').eq('card_id', card.id)
    expect(logs).toHaveLength(2)
  })

  it('replays a stale-due review correctly — idempotency outranks validation', async () => {
    const { card } = await seedCard(userAId, 'A deck (stale replay)')
    const args = reviewArgs(card.id, 1)

    const first = await clientA.rpc('apply_review', args)
    expect(first.error).toBeNull()
    expect(first.data![0].applied).toBe(true)

    // Simulate a late offline replay: same client_review_id, but p_due has
    // aged 10 minutes into the past. Without the idempotency-first ordering,
    // the future-date guard would reject this before reaching the idempotency
    // check.
    const stale = {
      ...args,
      p_due: new Date(Date.now() - 10 * 60_000).toISOString(),
    }
    const replay = await clientA.rpc('apply_review', stale)
    expect(replay.error).toBeNull()
    expect(replay.data![0].applied).toBe(false)
    // next_due is the ORIGINAL scheduled_due, not the stale p_due.
    expect(new Date(replay.data![0].next_due).getTime())
      .toBe(new Date(args.p_due).getTime())
  })

  // ------------------------------------------- REJECTION, NO SIDE EFFECTS ---

  it("A cannot apply a review to B's card — rejected, nothing changed", async () => {
    const { card: before } = await seedCard(userBId, 'B deck (ownership)')

    const { data, error } = await clientA.rpc('apply_review', reviewArgs(before.id))
    expect(error).not.toBeNull()
    expect(data).toBeNull()

    // B's card is untouched and no log was written.
    const { data: after } = await admin
      .from('cards').select('stability, reps').eq('id', before.id).single()
    expect(after!.reps).toBe(before.reps)
    expect(after!.stability).toBe(before.stability)

    const { data: logs } = await admin
      .from('review_logs').select('id').eq('card_id', before.id)
    expect(logs).toHaveLength(0)
  })

  it('an out-of-range FSRS value is rejected and leaves the card unchanged', async () => {
    const { card: before } = await seedCard(userAId, 'A deck (bad input)')

    // difficulty 50 is far outside the valid FSRS 1-10 band.
    const { data, error } = await clientA.rpc('apply_review',
      reviewArgs(before.id, 3, { p_difficulty: 50 }))
    expect(error).not.toBeNull()
    expect(data).toBeNull()

    // No partial write: the card is exactly as seeded.
    const { data: after } = await admin
      .from('cards').select('stability, difficulty, reps').eq('id', before.id).single()
    expect(after!.reps).toBe(before.reps)
    expect(after!.difficulty).toBe(before.difficulty)
    expect(after!.stability).toBe(before.stability)

    const { data: logs } = await admin
      .from('review_logs').select('id').eq('card_id', before.id)
    expect(logs).toHaveLength(0)
  })
})