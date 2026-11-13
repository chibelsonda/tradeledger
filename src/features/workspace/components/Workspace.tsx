import { Button } from '@headlessui/react'
import type { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  Organization,
  OrganizationMembership,
  OrganizationRole,
} from '../../../lib/database.types'
import { supabase } from '../../../lib/supabase'
import { OperationsDashboard } from '../../operations/components/OperationsDashboard'
import { OrganizationOnboarding } from './OrganizationOnboarding'

interface WorkspaceProps {
  session: Session
}

interface WorkspaceOrganization extends Organization {
  role: OrganizationRole
}

export function Workspace({ session }: WorkspaceProps) {
  const [organizations, setOrganizations] = useState<WorkspaceOrganization[]>([])
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(
    null,
  )
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadOrganizations = useCallback(
    async (preferredOrganizationId?: string) => {
      setIsLoading(true)
      setError(null)

      const [organizationResult, membershipResult] = await Promise.all([
        supabase.from('organizations').select('*').order('name'),
        supabase
          .from('organization_memberships')
          .select('*')
          .eq('user_id', session.user.id)
          .eq('status', 'active'),
      ])

      if (organizationResult.error || membershipResult.error) {
        setError(
          organizationResult.error?.message ?? membershipResult.error?.message ?? null,
        )
        setIsLoading(false)
        return
      }

      const roleByOrganization = new Map(
        membershipResult.data.map((membership: OrganizationMembership) => [
          membership.organization_id,
          membership.role,
        ]),
      )

      const availableOrganizations = organizationResult.data.flatMap(
        (organization: Organization) => {
          const role = roleByOrganization.get(organization.id)

          return role ? [{ ...organization, role }] : []
        },
      )

      setOrganizations(availableOrganizations)
      setSelectedOrganizationId((current) => {
        const preferred = preferredOrganizationId ?? current

        if (
          preferred &&
          availableOrganizations.some(
            (organization) => organization.id === preferred,
          )
        ) {
          return preferred
        }

        return availableOrganizations[0]?.id ?? null
      })
      setIsLoading(false)
    },
    [session.user.id],
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadOrganizations()
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [loadOrganizations])

  const selectedOrganization = useMemo(
    () =>
      organizations.find(
        (organization) => organization.id === selectedOrganizationId,
      ) ?? null,
    [organizations, selectedOrganizationId],
  )

  if (isLoading) {
    return (
      <div className="grid min-h-[65vh] place-items-center px-6">
        <div className="flex items-center gap-3 text-sm font-semibold text-forest">
          <span className="size-5 animate-spin rounded-full border-2 border-forest/15 border-t-forest" />
          Loading tenant-safe workspace…
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <section className="mx-auto w-full max-w-3xl px-6 py-16">
        <div className="border border-red-200 bg-red-50 p-6 text-red-900">
          <p className="font-bold">Workspace could not be loaded</p>
          <p className="mt-2 text-sm leading-6">{error}</p>
          <Button
            type="button"
            onClick={() => void loadOrganizations()}
            className="mt-5 bg-red-900 px-4 py-2.5 text-sm font-bold text-white"
          >
            Try again
          </Button>
        </div>
      </section>
    )
  }

  if (!selectedOrganization) {
    return (
      <OrganizationOnboarding
        onCreated={(organizationId) =>
          void loadOrganizations(organizationId)
        }
      />
    )
  }

  return (
    <OperationsDashboard
      session={session}
      organization={selectedOrganization}
      organizations={organizations}
      onSelectOrganization={setSelectedOrganizationId}
    />
  )
}
