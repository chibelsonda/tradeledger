import { z } from 'zod'

import { dollarsToMinorUnits } from '../../lib/payment-calculations'

const optionalEmailSchema = z
  .string()
  .trim()
  .max(320, 'Email must be 320 characters or fewer.')
  .refine(
    (value) => value === '' || z.email().safeParse(value).success,
    'Enter a valid email address.',
  )
  .transform((value) => value.toLowerCase())

export const projectFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Project name must contain at least 2 characters.')
    .max(160, 'Project name must be 160 characters or fewer.'),
  code: z
    .string()
    .min(2, 'Project code must contain at least 2 characters.')
    .max(32, 'Project code must be 32 characters or fewer.')
    .regex(
      /^[A-Z0-9][A-Z0-9-]+$/,
      'Use uppercase letters, numbers, and hyphens only.',
    ),
})

export const subcontractorFormSchema = z.object({
  companyName: z
    .string()
    .trim()
    .min(2, 'Company name must contain at least 2 characters.')
    .max(160, 'Company name must be 160 characters or fewer.'),
  contactName: z
    .string()
    .trim()
    .max(160, 'Contact name must be 160 characters or fewer.'),
  email: optionalEmailSchema,
})

export const paymentRequestFormSchema = z.object({
  projectId: z.string().uuid('Select a project.'),
  subcontractorId: z.string().uuid('Select a subcontractor.'),
  description: z
    .string()
    .trim()
    .min(3, 'Description must contain at least 3 characters.')
    .max(500, 'Description must be 500 characters or fewer.'),
  grossAmount: z
    .string()
    .refine(
      (value) => dollarsToMinorUnits(value) !== null,
      'Enter a positive amount with no more than 2 decimal places.',
    )
    .transform((value) => dollarsToMinorUnits(value) as number),
  retainagePercentage: z.coerce
    .number<number>()
    .finite('Enter a valid retainage percentage.')
    .min(0, 'Retainage cannot be below 0%.')
    .max(100, 'Retainage cannot exceed 100%.'),
})

export const organizationMemberFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter the registered user email address.')
    .email('Enter a valid registered user email address.')
    .max(320, 'Email must be 320 characters or fewer.')
    .transform((value) => value.toLowerCase()),
  role: z.enum(['admin', 'accountant', 'member', 'subcontractor'], {
    error: 'Select a supported organization role.',
  }),
})

export type ProjectFormValues = z.infer<typeof projectFormSchema>
export type SubcontractorFormValues = z.infer<typeof subcontractorFormSchema>
export type PaymentRequestFormValues = z.infer<typeof paymentRequestFormSchema>
export type OrganizationMemberFormValues = z.infer<
  typeof organizationMemberFormSchema
>
