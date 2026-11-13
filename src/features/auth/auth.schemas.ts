import { z } from 'zod'

export const authCredentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .email('Enter a valid email address.')
    .max(320, 'Email must be 320 characters or fewer.')
    .transform((value) => value.toLowerCase()),
  password: z
    .string()
    .min(8, 'Password must contain at least 8 characters.')
    .max(256, 'Password must be 256 characters or fewer.'),
})

export type AuthCredentials = z.infer<typeof authCredentialsSchema>
