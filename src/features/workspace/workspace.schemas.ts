import { z } from 'zod'

import { organizationSlug } from '../../lib/organizations'

export const organizationFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Organization name must contain at least 2 characters.')
    .max(120, 'Organization name must be 120 characters or fewer.'),
  slug: z
    .string()
    .transform(organizationSlug)
    .pipe(
      z
        .string()
        .min(2, 'Workspace URL must contain at least 2 characters.')
        .max(63, 'Workspace URL must be 63 characters or fewer.')
        .regex(
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          'Use lowercase letters, numbers, and single hyphens only.',
        ),
    ),
  includeDemoData: z.boolean(),
})

export type OrganizationFormValues = z.infer<typeof organizationFormSchema>
