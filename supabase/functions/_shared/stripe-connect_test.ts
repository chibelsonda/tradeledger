import assert from 'node:assert/strict'
import type Stripe from 'stripe'

import { stripeV2AccountReadiness } from './stripe-connect.ts'

function v2Account(
  transferStatus: 'active' | 'pending' | 'restricted' | 'unsupported',
  requirements: Stripe.V2.Core.Account.Requirements['entries'] = [],
): Stripe.V2.Core.Account {
  return {
    id: 'acct_12345678',
    object: 'v2.core.account',
    applied_configurations: ['recipient'],
    configuration: {
      recipient: {
        applied: true,
        capabilities: {
          stripe_balance: {
            stripe_transfers: {
              status: transferStatus,
              status_details: [],
            },
          },
        },
      },
    },
    created: '2026-11-26T00:00:00.000Z',
    livemode: false,
    requirements: { entries: requirements },
  }
}

Deno.test('v2 recipient readiness follows the Stripe transfer capability', () => {
  const readiness = stripeV2AccountReadiness(v2Account('active'))

  assert.equal(readiness.p_payouts_enabled, true)
  assert.equal(readiness.p_details_submitted, true)
  assert.equal(readiness.p_disabled_reason, null)
})

Deno.test('v2 recipient readiness preserves actionable requirement states', () => {
  const requirement = {
    awaiting_action_from: 'user' as const,
    description: 'Provide a payout bank account.',
    errors: [],
    impact: {},
    minimum_deadline: { status: 'currently_due' as const },
    requested_reasons: [],
  }
  const readiness = stripeV2AccountReadiness(
    v2Account('restricted', [requirement]),
  )

  assert.deepEqual(readiness.p_requirements_currently_due, [
    'Provide a payout bank account.',
  ])
  assert.equal(readiness.p_details_submitted, false)
  assert.equal(
    readiness.p_disabled_reason,
    'recipient.stripe_transfers.restricted',
  )
})
