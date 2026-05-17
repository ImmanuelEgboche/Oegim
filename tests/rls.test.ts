import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Service-role client: bypasses RLS — used only for setup and teardown
const admin = createClient(URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

describe('RLS: cards are private to their owner', () => {
  const ts = Date.now()
  const emailA = `rls-a-${ts}@test.invalid`
  const emailB = `rls-b-${ts}@test.invalid`
  const password = 'Rls-Test-Pass-1!'

  let userAId: string
  let userBId: string
  let cardBId: string

  beforeAll(async () => {
    // Create both users with email already confirmed
    const { data: a, error: errA } = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    })
    if (errA || !a.user) throw errA
    userAId = a.user.id

    const { data: b, error: errB } = await admin.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    })
    if (errB || !b.user) throw errB
    userBId = b.user.id

    // Seed: deck + card owned by user B (service role skips RLS)
    const { data: deck, error: deckErr } = await admin
      .from('decks')
      .insert({ user_id: userBId, name: 'B private deck' })
      .select('id')
      .single()
    if (deckErr || !deck) throw deckErr

    const { data: card, error: cardErr } = await admin
      .from('cards')
      .insert({
        deck_id: deck.id,
        user_id: userBId,
        front: 'secret front',
        back: 'secret back',
      })
      .select('id')
      .single()
    if (cardErr || !card) throw cardErr
    cardBId = card.id
  })

  afterAll(async () => {
    // Deleting users cascades to their decks, cards, and logs
    if (userAId) await admin.auth.admin.deleteUser(userAId)
    if (userBId) await admin.auth.admin.deleteUser(userBId)
  })

  it("user A gets an empty result when querying user B's card directly", async () => {
    // Sign in as user A with an anon-key client (RLS is active)
    const clientA = createClient(URL, ANON, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error: signInErr } = await clientA.auth.signInWithPassword({
      email: emailA,
      password,
    })
    expect(signInErr).toBeNull()

    const { data, error } = await clientA
      .from('cards')
      .select('id')
      .eq('id', cardBId)

    // RLS silently filters the row — no error, just zero results
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })
})
