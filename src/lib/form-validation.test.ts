import { describe, expect, it } from 'vitest'

import {
  authCredentialsSchema,
  passwordResetRequestSchema,
  passwordUpdateSchema,
} from '@/features/auth/auth.schemas'
import {
  organizationMemberFormSchema,
  paymentRequestFormSchema,
  platformFeeFormSchema,
  projectFormSchema,
  subcontractorFormSchema,
} from '@/features/operations/operations.schemas'
import { organizationFormSchema } from '@/features/workspace/workspace.schemas'

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

  it('normalizes password reset email addresses', () => {
    expect(
      passwordResetRequestSchema.parse({ email: '  OWNER@EXAMPLE.COM ' }),
    ).toEqual({ email: 'owner@example.com' })
  })

  it('requires matching passwords when completing recovery', () => {
    const result = passwordUpdateSchema.safeParse({
      password: 'correct-horse',
      confirmPassword: 'different-horse',
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['confirmPassword'])
    }
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

  it('normalizes editable project values', () => {
    expect(
      projectFormSchema.parse({
        name: '  Cedar Kitchen Remodel  ',
        code: 'CEDAR-01',
      }),
    ).toEqual({ name: 'Cedar Kitchen Remodel', code: 'CEDAR-01' })
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

  it('normalizes editable subcontractor contact details', () => {
    expect(
      subcontractorFormSchema.parse({
        companyName: '  Fine Finish Carpentry  ',
        contactName: '  Hector Ramirez  ',
        email: '  HECTOR@EXAMPLE.COM  ',
      }),
    ).toEqual({
      companyName: 'Fine Finish Carpentry',
      contactName: 'Hector Ramirez',
      email: 'hector@example.com',
    })
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

  it('converts a valid platform fee policy to server units', () => {
    expect(
      platformFeeFormSchema.parse({
        enabled: true,
        percentage: '2.75',
        fixedAmount: '0.30',
      }),
    ).toEqual({ enabled: true, percentage: 275, fixedAmount: 30 })
  })

  it('rejects an enabled platform fee without a fee component', () => {
    expect(
      platformFeeFormSchema.safeParse({
        enabled: true,
        percentage: '0',
        fixedAmount: '0.00',
      }).success,
    ).toBe(false)
  })
})
