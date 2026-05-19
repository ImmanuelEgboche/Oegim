import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

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

describe('RLS: subscriptions are read-only for their owner', () => {
  const ts = Date.now()
  const email = `rls-sub-${ts}@test.invalid`
  const password = 'Rls-Test-Pass-1!'

  let userId: string
  let clientA: SupabaseClient

  beforeAll(async () => {
    const { data, error: errCreate } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (errCreate || !data.user) throw errCreate
    userId = data.user.id

    // Seed a 'free' subscription row via service role (no RLS).
    const { error: errInsert } = await admin
      .from('subscriptions')
      .insert({ user_id: userId, plan: 'free' })
    if (errInsert) throw errInsert

    clientA = await signInAs(email, password)
  })

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId)
  })

  it('owner can read their own subscription', async () => {
    const { data, error } = await clientA
      .from('subscriptions')
      .select('plan')
      .eq('user_id', userId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].plan).toBe('free')
  })

  it('owner cannot UPDATE their own subscription to plan = pro — "make myself Pro for free" attack', async () => {
    // No UPDATE policy exists on subscriptions. RLS silently filters the row
    // out of the candidate set, so the update touches 0 rows and returns no
    // error — the same behaviour as a blocked UPDATE on cards.
    const { data, error } = await clientA
      .from('subscriptions')
      .update({ plan: 'pro' })
      .eq('user_id', userId)
      .select('plan')
    expect(error).toBeNull()
    expect(data).toHaveLength(0)

    // Independently confirm via admin that the plan is still 'free'.
    const { data: check } = await admin
      .from('subscriptions')
      .select('plan')
      .eq('user_id', userId)
      .single()
    expect(check?.plan).toBe('free')
  })

  it('owner cannot INSERT a new subscription row with plan = pro', async () => {
    // Even if they try to write a fresh row, the missing INSERT policy blocks it.
    const { error } = await clientA
      .from('subscriptions')
      .insert({ user_id: userId, plan: 'pro' })
    expect(error).not.toBeNull()
  })

  it('unauthenticated client sees no subscription rows', async () => {
    const anon = createClient(URL, ANON, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data, error } = await anon
      .from('subscriptions')
      .select('plan')
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })
})
