import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { error } from 'console'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Service-role client: bypasses RLS — used only for setup and teardown and
// independently verifying that attacked rows are genuinely untouched.
const admin = createClient(URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// A fresh anon-key client signed in as the given user. RLS is fully active here

async function signInAs(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

describe('RLS: cards are private to their owner', () => {
  const ts = Date.now()
  const emailA = `rls-a-${ts}@test.invalid`
  const emailB = `rls-b-${ts}@test.invalid`
  const password = 'Rls-Test-Pass-1!'

  let userAId: string
  let userBId: string
  let deckAId: string
  let deckBId: string
  let cardBId: string
  let clientA: SupabaseClient
  let clientB: SupabaseClient
  
  beforeAll(async () => {
    // --- Users (email pre-confirmed so sign-in works immediately) ---
    const { data: a, error: errA } = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    })
    if (errA || !a.user) throw errA
    userAId = a.user.id

    const { data: b, error: errB } = await admin.auth.admin.createUser({
      email: emailB, password, email_confirm: true,
    })
    if (errB || !b.user) throw errB
    userBId = b.user.id
 
    // --- Seed data (service role skips RLS) ---
    const { data: deckA, error: dAErr } = await admin
      .from('decks').insert({ user_id: userAId, name: 'A deck' })
      .select('id').single()
    if (dAErr || !deckA) throw dAErr
    deckAId = deckA.id
 
    const { data: deckB, error: dBErr } = await admin
      .from('decks').insert({ user_id: userBId, name: 'B private deck' })
      .select('id').single()
    if (dBErr || !deckB) throw dBErr
    deckBId = deckB.id
 
    const { data: card, error: cErr } = await admin
      .from('cards')
      .insert({ deck_id: deckBId, user_id: userBId, front: 'secret front', back: 'secret back' })
      .select('id').single()
    if (cErr || !card) throw cErr
    cardBId = card.id
 
    // --- Signed-in clients with RLS active ---
    clientA = await signInAs(emailA, password)
    clientB = await signInAs(emailB, password)
  })
 
  afterAll(async () => {
    // Deleting users cascades to their decks, cards, and review logs.
    if (userAId) await admin.auth.admin.deleteUser(userAId)
    if (userBId) await admin.auth.admin.deleteUser(userBId)
  })
 
  // ---------------------------------------------------------------- READ ---
 
  it('an unauthenticated client sees no cards at all', async () => {
    const anon = createClient(URL, ANON, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data, error } = await anon.from('cards').select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })
 
  it("A cannot read B's card — RLS filters it to an empty result", async () => {
    const { data, error } = await clientA
      .from('cards').select('id').eq('id', cardBId)
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })
 
  it('B CAN read their own card — proves RLS is not blocking everything', async () => {
    const { data, error } = await clientB
      .from('cards').select('id').eq('id', cardBId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })
 
  // --------------------------------------------------------------- WRITE ---
  // The dangerous direction. Note the asymmetry in how Postgres rejects:
  //   UPDATE / DELETE blocked by USING       -> no error, simply 0 rows affected
  //   INSERT  blocked by WITH CHECK          -> a real error is returned
 
  it("A cannot UPDATE B's card", async () => {
    const { data, error } = await clientA
      .from('cards').update({ front: 'tampered' }).eq('id', cardBId).select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
 
    // Independently confirm via admin that the row is genuinely untouched.
    const { data: check } = await admin
      .from('cards').select('front').eq('id', cardBId).single()
    expect(check?.front).toBe('secret front')
  })
 
  it("A cannot DELETE B's card", async () => {
    const { data, error } = await clientA
      .from('cards').delete().eq('id', cardBId).select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
 
    const { count } = await admin
      .from('cards').select('id', { count: 'exact', head: true }).eq('id', cardBId)
    expect(count).toBe(1)
  })
 
  it("A cannot INSERT a card claiming B as the owner — WITH CHECK rejects it", async () => {
    const { error } = await clientA.from('cards').insert({
      deck_id: deckBId, user_id: userBId, front: 'injected', back: 'injected',
    }).select('id')
    expect(error).not.toBeNull()
  })
 
  it("A cannot smuggle a card into B's deck under A's own user_id", async () => {
    // user_id = A satisfies the WITH CHECK on user_id, but deck_id points at
    // B's deck. This MUST be rejected by the composite FK
    //   cards (deck_id, user_id) -> decks (id, user_id).
    // If this test fails, that foreign key is missing from the schema.
    const { error } = await clientA.from('cards').insert({
      deck_id: deckBId, user_id: userAId, front: 'smuggled', back: 'smuggled',
    }).select('id')
    expect(error).not.toBeNull()
  })
 
  it('A CAN insert a card into their own deck — positive write case', async () => {
    const { data, error } = await clientA.from('cards').insert({
      deck_id: deckAId, user_id: userAId, front: 'A legit front', back: 'A legit back',
    }).select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })
})