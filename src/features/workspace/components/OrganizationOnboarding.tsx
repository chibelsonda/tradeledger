import { Button, Field, Input, Label } from '@headlessui/react'
import { useState } from 'react'

import { FieldError } from '../../../components/ui/FieldError'
import { organizationSlug } from '../../../lib/organizations'
import { supabase } from '../../../lib/supabase'
import {
  fieldErrorsFromZod,
  type FieldErrors,
} from '../../../lib/validation'
import {
  organizationFormSchema,
  type OrganizationFormValues,
} from '../workspace.schemas'

interface OrganizationOnboardingProps {
  onCreated: (organizationId: string) => void
}

type OrganizationField = keyof OrganizationFormValues

export function OrganizationOnboarding({
  onCreated,
}: OrganizationOnboardingProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [isSlugEdited, setIsSlugEdited] = useState(false)
  const [includeDemoData, setIncludeDemoData] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<
    FieldErrors<OrganizationField>
  >({})

  function updateName(value: string) {
    setName(value)

    if (!isSlugEdited) {
      setSlug(organizationSlug(value))
    }
  }

  async function createOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const validation = organizationFormSchema.safeParse({
      name,
      slug,
      includeDemoData,
    })

    if (!validation.success) {
      setFieldErrors(fieldErrorsFromZod<OrganizationField>(validation.error))
      return
    }

    setFieldErrors({})
    setIsSubmitting(true)

    const { data, error: createError } = await supabase.rpc(
      'create_organization_workspace',
      {
        p_name: validation.data.name,
        p_slug: validation.data.slug,
        p_seed_demo: validation.data.includeDemoData,
      },
    )

    setIsSubmitting(false)

    if (createError) {
      setError(
        createError.code === '23505'
          ? 'That workspace URL is already in use.'
          : createError.message,
      )
      return
    }

    onCreated(data)
  }

  return (
    <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-12 lg:min-h-[calc(100vh-10rem)] lg:grid-cols-[0.9fr_1.1fr] lg:px-8 lg:py-16">
      <div className="flex max-w-xl flex-col gap-6">
        <span className="w-fit border border-forest/15 bg-white/70 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.16em] text-forest">
          Tenant-safe foundation
        </span>
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl leading-[1.05] font-extrabold tracking-[-0.045em] text-ink sm:text-5xl">
            Create your contractor workspace.
          </h1>
          <p className="max-w-lg text-base leading-7 font-medium text-ink/85">
            Projects, subcontractors, payment requests, and audit history are
            isolated by organization with data-layer access policies.
          </p>
        </div>
        <div className="grid gap-3 text-sm text-ink/80 sm:grid-cols-3">
          {[
            ['01', 'Organization-scoped data'],
            ['02', 'Role-aware access'],
            ['03', 'Immutable audit events'],
          ].map(([number, label]) => (
            <div key={number} className="border-t border-ink/15 pt-3">
              <span className="font-mono text-xs font-bold text-forest/80">
                {number}
              </span>
              <p className="mt-2 font-semibold text-ink">{label}</p>
            </div>
          ))}
        </div>
      </div>

      <form
        noValidate
        onSubmit={(event) => void createOrganization(event)}
        className="flex flex-col gap-6 border border-ink/10 bg-white p-7 shadow-[0_24px_64px_rgba(19,37,31,0.12)] sm:p-9"
      >
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-forest/80">
            Organization onboarding
          </p>
          <h2 className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
            Start your workspace
          </h2>
          <p className="mt-2 text-sm leading-6 font-medium text-ink/80">
            You will become the owner. Membership creation and the audit event
            are committed in one database transaction.
          </p>
        </div>

        <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
          <Label>Organization name</Label>
          <Input
            required
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(event) => {
              updateName(event.target.value)
              setFieldErrors((current) => ({ ...current, name: undefined }))
            }}
            aria-invalid={Boolean(fieldErrors.name)}
            aria-describedby={
              fieldErrors.name ? 'organization-name-error' : undefined
            }
            placeholder="North Ridge Contracting"
            className="h-10 border border-ink/15 bg-white px-3.5 font-medium outline-none transition placeholder:text-ink/60 focus:border-forest focus:ring-2 focus:ring-forest/10 aria-invalid:border-red-500 aria-invalid:focus:border-red-600 aria-invalid:focus:ring-red-500/10"
          />
          <FieldError
            id="organization-name-error"
            message={fieldErrors.name}
          />
        </Field>

        <label className="flex cursor-pointer items-start gap-3 border border-ink/10 bg-cream/70 p-4">
          <input
            type="checkbox"
            checked={includeDemoData}
            onChange={(event) => setIncludeDemoData(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-forest"
          />
          <span>
            <span className="block text-sm font-bold text-ink">
              Add a production-safe sample workspace
            </span>
            <span className="mt-1 block text-xs leading-5 font-medium text-ink/80">
              Creates two projects, two subcontractors, and draft, submitted,
              and approved payment examples inside your tenant only.
            </span>
          </span>
        </label>

        <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
          <Label>Workspace URL</Label>
          <div
            className={
              'flex h-10 items-center overflow-hidden border bg-white focus-within:ring-2 ' +
              (fieldErrors.slug
                ? 'border-red-500 focus-within:border-red-600 focus-within:ring-red-500/10'
                : 'border-ink/15 focus-within:border-forest focus-within:ring-forest/10')
            }
          >
            <span className="border-r border-ink/10 px-3 text-xs font-semibold text-ink/80">
              /workspace/
            </span>
            <Input
              required
              minLength={2}
              maxLength={63}
              value={slug}
              onChange={(event) => {
                setIsSlugEdited(true)
                setSlug(organizationSlug(event.target.value))
                setFieldErrors((current) => ({ ...current, slug: undefined }))
              }}
              aria-invalid={Boolean(fieldErrors.slug)}
              aria-describedby={
                fieldErrors.slug ? 'organization-slug-error' : undefined
              }
              placeholder="north-ridge"
              className="h-full min-w-0 flex-1 bg-white px-3 font-mono text-sm font-normal outline-none placeholder:text-ink/60"
            />
          </div>
          <FieldError
            id="organization-slug-error"
            message={fieldErrors.slug}
          />
        </Field>

        {error && (
          <div
            role="alert"
            className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            {error}
          </div>
        )}

        <Button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex h-10 items-center justify-center bg-ink px-5 text-sm font-bold text-white shadow-[0_10px_24px_rgba(19,37,31,0.18)] transition hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-wait disabled:opacity-60"
        >
          {isSubmitting ? 'Creating secure workspace…' : 'Create organization'}
        </Button>
      </form>
    </section>
  )
}
