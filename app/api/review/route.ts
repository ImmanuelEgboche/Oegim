// app/api/review/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { fsrs, generatorParameters, Rating, State } from 'ts-fsrs'
import { rateLimit } from '@/lib/rate-limit'

const ReviewSchema = z.object({
  client_review_id: z.string().uuid(),
  card_id: z.string().uuid(),
  rating: z.number().int().min(1).max(4),
  duration_ms: z.number().int().min(0).max(600_000).optional(),
})

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }))

export async function POST(req: NextRequest) {
  // 1. Auth: server-verified, not cached
  const supabase = createRouteHandlerClient({ cookies })
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 2. Rate limit: per user, not per IP (mobile users share NATs)
  const { ok, retryAfter } = await rateLimit(`review:${user.id}`, 120, '1m')
  if (!ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      },
    )
  }

  // 3. Validate input strictly
  let body: z.infer<typeof ReviewSchema>
  try {
    body = ReviewSchema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  // 4. Load card — RLS guarantees it belongs to this user
  const { data: card, error: loadErr } = await supabase
    .from('cards')
    .select('*')
    .eq('id', body.card_id)
    .single()

  if (loadErr || !card) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // 5. Idempotency: if this client_review_id already logged, no-op
  const { data: existing } = await supabase
    .from('review_logs')
    .select('id')
    .eq('user_id', user.id)
    .eq('client_review_id', body.client_review_id)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ status: 'already_applied' }, { status: 200 })
  }

  // 6. Run FSRS server-side. Client never computes scheduling.
  const now = new Date()
  const scheduling = scheduler.repeat(
    {
      due: new Date(card.due),
      stability: card.stability,
      difficulty: card.difficulty,
      elapsed_days:
        card.reps === 0
          ? 0
          : (now.getTime() - new Date(card.updated_at).getTime()) / 86_400_000,
      scheduled_days: 0,
      reps: card.reps,
      lapses: card.lapses,
      state: card.state as State,
      last_review: new Date(card.updated_at),
    },
    now,
  )

  const next = scheduling[body.rating as Rating].card
  const log = scheduling[body.rating as Rating].log

  // 7. Write card + log in one transaction via RPC, not two round trips
  const { error: rpcErr } = await supabase.rpc('apply_review', {
    p_card_id: card.id,
    p_client_review_id: body.client_review_id,
    p_stability: next.stability,
    p_difficulty: next.difficulty,
    p_due: next.due.toISOString(),
    p_state: next.state,
    p_reps: next.reps,
    p_lapses: next.lapses,
    p_rating: body.rating,
    p_elapsed_days: log.elapsed_days,
    p_scheduled_days: log.scheduled_days,
    p_duration_ms: body.duration_ms ?? null,
  })

  if (rpcErr) {
    // Sentry captures via instrumentation; don't leak details to client
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }

  return NextResponse.json({
    status: 'ok',
    next_due: next.due.toISOString(),
  })
}
