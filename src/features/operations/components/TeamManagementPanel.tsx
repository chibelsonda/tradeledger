import { Button, Field, Input, Label } from '@headlessui/react'
import type { FormEvent } from 'react'

import type {
  OrganizationMember,
  OrganizationRole,
} from '../../../lib/database.types'
import { FieldError } from '../../../components/ui/FieldError'
import { ButtonSpinner } from '../../../components/ui/ButtonSpinner'
import { formatStatus } from '../../../lib/format'
import { SelectControl } from '../../../components/ui/SelectControl'

interface TeamManagementPanelProps {
  members: OrganizationMember[]
  currentUserId: string
  currentUserRole: OrganizationRole
  email: string
  role: Exclude<OrganizationRole, 'owner'>
  busyUserId: string | null
  isSubmitting: boolean
  fieldErrors: { email?: string; role?: string }
  onEmailChange: (value: string) => void
  onRoleChange: (value: Exclude<OrganizationRole, 'owner'>) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onStatusChange: (
    member: OrganizationMember,
    status: 'active' | 'suspended',
  ) => void
}

const inputClassName =
  'h-10 border border-ink/15 bg-white px-3.5 text-sm font-medium text-ink outline-none transition placeholder:text-ink/60 focus:border-forest focus:ring-2 focus:ring-forest/10 aria-invalid:!border-red-600 aria-invalid:!ring-1 aria-invalid:!ring-red-600/20 aria-invalid:focus:!border-red-700 aria-invalid:focus:!ring-2 aria-invalid:focus:!ring-red-600/20'

function canManageMember(
  actorRole: OrganizationRole,
  member: OrganizationMember,
): boolean {
  if (member.role === 'owner') return false
  if (actorRole === 'owner') return true

  return !['admin', 'accountant'].includes(member.role)
}

export function TeamManagementPanel({
  members,
  currentUserId,
  currentUserRole,
  email,
  role,
  busyUserId,
  isSubmitting,
  fieldErrors,
  onEmailChange,
  onRoleChange,
  onSubmit,
  onStatusChange,
}: TeamManagementPanelProps) {
  const availableRoles: Exclude<OrganizationRole, 'owner'>[] =
    currentUserRole === 'owner'
      ? ['admin', 'accountant', 'member', 'subcontractor']
      : ['member', 'subcontractor']

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="border border-ink/10 bg-white p-6 shadow-[0_16px_40px_rgba(19,37,31,0.055)]">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.17em] text-forest/80">
              Access control
            </p>
            <h2 className="mt-1 text-lg font-extrabold tracking-[-0.02em] text-ink">Organization team</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 font-medium text-ink/80">
              Roles are enforced by data-access policies and server-side workflow
              controls. Suspended members immediately lose tenant access.
            </p>
          </div>
          <span className="w-fit border border-ink/10 bg-cream px-3 py-1.5 font-mono text-xs font-bold text-ink/80">
            {members.filter((member) => member.status === 'active').length} active
          </span>
        </div>

        <div className="mt-6 overflow-x-auto border border-ink/10">
          <table className="min-w-full divide-y divide-ink/10 text-left text-sm">
            <thead className="bg-cream text-[10px] uppercase tracking-[0.15em] text-ink/80">
              <tr>
                <th className="px-4 py-3 font-bold">User</th>
                <th className="px-4 py-3 font-bold">Role</th>
                <th className="px-4 py-3 font-bold">Status</th>
                <th className="px-4 py-3 text-right font-bold">Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/8">
              {members.map((member) => {
                const isBusy = busyUserId === member.user_id
                const isManageable = canManageMember(currentUserRole, member)

                return (
                  <tr key={member.user_id} className="transition-colors hover:bg-cream/45">
                    <td className="px-4 py-4">
                      <p className="font-bold text-ink">{member.email}</p>
                      {member.user_id === currentUserId && (
                        <p className="mt-1 text-xs text-forest">Current user</p>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <span className="border border-ink/10 bg-cream px-2 py-1 text-xs font-bold text-ink/80">
                        {formatStatus(member.role)}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <span
                        className={
                          'border px-2 py-1 text-xs font-bold ' +
                          (member.status === 'active'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                            : 'border-amber-200 bg-amber-50 text-amber-900')
                        }
                      >
                        {formatStatus(member.status)}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-right">
                      {isManageable ? (
                        <Button
                          type="button"
                          disabled={busyUserId !== null}
                          aria-busy={isBusy}
                          onClick={() =>
                            onStatusChange(
                              member,
                              member.status === 'active' ? 'suspended' : 'active',
                            )
                          }
                          className={
                            'inline-flex items-center justify-center gap-2 border px-3 py-2 text-xs font-bold transition disabled:cursor-wait disabled:opacity-50 ' +
                            (member.status === 'active'
                              ? 'border-red-200 text-red-700 hover:bg-red-50'
                              : 'border-emerald-200 text-emerald-800 hover:bg-emerald-50')
                          }
                        >
                          {isBusy && <ButtonSpinner />}
                          {isBusy
                            ? 'Updating…'
                            : member.status === 'active'
                              ? 'Suspend'
                              : 'Restore'}
                        </Button>
                      ) : (
                        <span className="text-xs text-ink/55">
                          {member.role === 'owner' ? 'Protected owner' : 'Owner required'}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <form
        noValidate
        autoComplete="off"
        onSubmit={onSubmit}
        className="h-fit border border-ink/10 bg-white p-6 shadow-[0_16px_40px_rgba(19,37,31,0.055)]"
      >
        <p className="text-[11px] font-bold uppercase tracking-[0.17em] text-forest/80">
          Add existing user
        </p>
        <h2 className="mt-1 text-lg font-extrabold tracking-[-0.02em] text-ink">Grant workspace access</h2>
        <p className="mt-2 text-sm leading-6 font-medium text-ink/80">
          The user must already have a TradeLedger account. Re-adding a suspended
          user restores their access with the selected role.
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
            <Label>Email</Label>
            <Input
              autoComplete="off"
              required
              type="email"
              maxLength={320}
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              aria-invalid={Boolean(fieldErrors.email)}
              data-validation-error={Boolean(fieldErrors.email) || undefined}
              aria-describedby={
                fieldErrors.email ? 'member-email-error' : undefined
              }
              placeholder="teammate@example.com"
              className={inputClassName}
            />
            <FieldError id="member-email-error" message={fieldErrors.email} />
          </Field>

          <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
            <Label>Role</Label>
            <SelectControl
              value={role}
              onChange={(value) =>
                onRoleChange(value as Exclude<OrganizationRole, 'owner'>)
              }
              options={availableRoles.map((availableRole) => ({
                value: availableRole,
                label: formatStatus(availableRole),
              }))}
              ariaLabel="Role"
              ariaDescribedBy={
                fieldErrors.role ? 'member-role-error' : undefined
              }
              invalid={Boolean(fieldErrors.role)}
              className={inputClassName}
            />
            <FieldError id="member-role-error" message={fieldErrors.role} />
          </Field>
        </div>

        <Button
          type="submit"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
          className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 bg-ink px-4 text-sm font-bold text-white transition hover:bg-forest disabled:cursor-wait disabled:opacity-50"
        >
          {isSubmitting && <ButtonSpinner tone="light" />}
          {isSubmitting ? 'Granting access…' : 'Add or update member'}
        </Button>
      </form>
    </div>
  )
}
