import { z } from 'zod'

const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .email('Enter a valid email address.')
  .max(320, 'Email must be 320 characters or fewer.')
  .transform((value) => value.toLowerCase())

const passwordSchema = z
  .string()
  .min(8, 'Password must contain at least 8 characters.')
  .max(256, 'Password must be 256 characters or fewer.')

export const authCredentialsSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
})

export const passwordResetRequestSchema = z.object({
  email: emailSchema,
})

export const passwordUpdateSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Confirm your new password.'),
  })
  .refine(({ password, confirmPassword }) => password === confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  })

export type AuthCredentials = z.infer<typeof authCredentialsSchema>
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>
export type PasswordUpdate = z.infer<typeof passwordUpdateSchema>
