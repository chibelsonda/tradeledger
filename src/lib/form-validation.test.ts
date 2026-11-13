import { describe, expect, it } from 'vitest'

import { authCredentialsSchema } from '../features/auth/auth.schemas'
import {
  organizationMemberFormSchema,
  paymentRequestFormSchema,
  projectFormSchema,
  subcontractorFormSchema,
} from '../features/operations/operations.schemas'
import { organizationFormSchema } from '../features/workspace/workspace.schemas'

describe('form validation schemas', () => {
  it('normalizes valid authentication credentials', () => {
    expect(
      authCredentialsSchema.parse({
        email: '  OWNER@EXAMPLE.COM ',
        password: 'correct-horse',
      }),
    ).toEqual({ email: 'owner@example.com', password: 'correct-horse' })
  })

  it('rejects weak authentication credentials', () => {
    expect(
      authCredentialsSchema.safeParse({ email: 'invalid', password: 'short' })
        .success,
    ).toBe(false)
  })

  it('normalizes organization onboarding values', () => {
    expect(
      organizationFormSchema.parse({
        name: '  North Ridge Contracting ',
        slug: ' North Ridge ',
        includeDemoData: true,
      }),
    ).toEqual({
      name: 'North Ridge Contracting',
      slug: 'north-ridge',
      includeDemoData: true,
    })
  })

  it('matches project constraints enforced by PostgreSQL', () => {
    expect(
      projectFormSchema.safeParse({ name: 'Kitchen', code: 'INVALID CODE' }).success,
    ).toBe(false)
  })

  it('accepts an optional subcontractor email', () => {
    expect(
      subcontractorFormSchema.parse({
        companyName: 'Fine Finish',
        contactName: '',
        email: '',
      }).email,
    ).toBe('')
  })

  it('converts validated payment values for database submission', () => {
    const result = paymentRequestFormSchema.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      subcontractorId: '00000000-0000-4000-8000-000000000002',
      description: 'Kitchen trim milestone',
      grossAmount: '2850.50',
      retainagePercentage: '10',
    })

    expect(result.grossAmount).toBe(285_050)
    expect(result.retainagePercentage).toBe(10)
  })

  it('validates organization membership roles and email addresses', () => {
    expect(
      organizationMemberFormSchema.safeParse({
        email: 'owner@example.com',
        role: 'owner',
      }).success,
    ).toBe(false)
  })
})
