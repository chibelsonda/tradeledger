import { useState } from 'react'

import { organizationSlug } from '../lib/organizations'
import { supabase } from '../lib/supabase'

interface OrganizationOnboardingProps {
  onCreated: (organizationId: string) => void
}

export function OrganizationOnboarding({
  onCreated,
}: OrganizationOnboardingProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [isSlugEdited, setIsSlugEdited] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateName(value: string) {
    setName(value)

    if (!isSlugEdited) {
      setSlug(organizationSlug(value))
    }
  }

  async function createOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const normalizedName = name.trim()
    const normalizedSlug = organizationSlug(slug)

    if (normalizedName.length < 2 || normalizedSlug.length < 2) {
      setError('Enter an organization name and a valid workspace URL.')
      return
    }

    setIsSubmitting(true)

    const { data, error: createError } = await supabase.rpc(
      'create_organization',
      {
        p_name: normalizedName,
        p_slug: normalizedSlug,
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
    <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-6 py-12 lg:grid-cols-[0.9fr_1.1fr] lg:px-8 lg:py-20">
      <div className="flex max-w-xl flex-col gap-6">
        <span className="w-fit border border-forest/15 bg-white/70 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.16em] text-forest">
          Tenant-safe foundation
        </span>
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl leading-tight font-black tracking-[-0.04em] text-ink sm:text-5xl">
            Create your contractor workspace.
          </h1>
          <p className="max-w-lg text-base leading-7 text-ink/65">
            Projects, subcontractors, payment requests, and audit history are
            isolated by organization with PostgreSQL Row-Level Security.
          </p>
        </div>
        <div className="grid gap-3 text-sm text-ink/70 sm:grid-cols-3">
          {[
            ['01', 'Organization-scoped data'],
            ['02', 'Role-aware access'],
            ['03', 'Immutable audit events'],
          ].map(([number, label]) => (
            <div key={number} className="border-t border-ink/15 pt-3">
              <span className="font-mono text-xs font-bold text-forest/55">
                {number}
              </span>
              <p className="mt-2 font-semibold text-ink">{label}</p>
            </div>
          ))}
        </div>
      </div>

      <form
        onSubmit={(event) => void createOrganization(event)}
        className="flex flex-col gap-6 border border-ink/10 bg-white p-7 shadow-[0_32px_80px_rgba(16,35,31,0.13)] sm:p-10"
      >
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-forest/60">
            Organization onboarding
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-ink">
            Start your workspace
          </h2>
          <p className="mt-2 text-sm leading-6 text-ink/55">
            You will become the owner. Membership creation and the audit event
            are committed in one database transaction.
          </p>
        </div>

        <label className="flex flex-col gap-2 text-sm font-bold text-ink">
          Organization name
          <input
            required
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(event) => updateName(event.target.value)}
            placeholder="North Ridge Contracting"
            className="h-12 border border-ink/15 bg-cream/60 px-4 font-normal outline-none transition placeholder:text-ink/30 focus:border-forest focus:ring-2 focus:ring-forest/10"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-bold text-ink">
          Workspace URL
          <div className="flex h-12 items-center overflow-hidden border border-ink/15 bg-cream/60 focus-within:border-forest focus-within:ring-2 focus-within:ring-forest/10">
            <span className="border-r border-ink/10 px-3 text-xs font-semibold text-ink/40">
              /workspace/
            </span>
            <input
              required
              minLength={2}
              value={slug}
              onChange={(event) => {
                setIsSlugEdited(true)
                setSlug(organizationSlug(event.target.value))
              }}
              placeholder="north-ridge"
              className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-sm font-normal outline-none placeholder:text-ink/30"
            />
          </div>
        </label>

        {error && (
          <div
            role="alert"
            className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex h-13 items-center justify-center bg-ink px-6 text-sm font-bold text-white shadow-[0_14px_32px_rgba(16,35,31,0.2)] transition hover:-translate-y-0.5 hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-wait disabled:translate-y-0 disabled:opacity-60"
        >
          {isSubmitting ? 'Creating secure workspace…' : 'Create organization'}
        </button>
      </form>
    </section>
  )
}
