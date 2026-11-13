import {
  Button,
  Description,
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Field,
  Input,
  Label,
} from '@headlessui/react'
import type { FormEvent } from 'react'
import { useState } from 'react'

import { ButtonSpinner } from '../../../components/ui/ButtonSpinner'
import { FieldError } from '../../../components/ui/FieldError'
import { NotificationBanner } from '../../../components/ui/NotificationBanner'
import type { Project, Subcontractor } from '../../../lib/database.types'
import { projectCode } from '../../../lib/organizations'
import {
  fieldErrorsFromZod,
  type FieldErrors,
} from '../../../lib/validation'
import {
  projectFormSchema,
  subcontractorFormSchema,
  type ProjectFormValues,
  type SubcontractorFormValues,
} from '../operations.schemas'

export type DirectoryEditTarget =
  | { kind: 'project'; record: Project }
  | { kind: 'subcontractor'; record: Subcontractor }

interface DirectoryEditDialogProps {
  target: DirectoryEditTarget | null
  isSaving: boolean
  serverError: string | null
  onClose: () => void
  onClearError: () => void
  onSaveProject: (projectId: string, values: ProjectFormValues) => Promise<void>
  onSaveSubcontractor: (
    subcontractorId: string,
    values: SubcontractorFormValues,
  ) => Promise<void>
}

const fieldClassName =
  'h-10 border border-ink/15 bg-white px-3.5 text-sm font-medium text-ink outline-none transition placeholder:text-ink/60 focus:border-forest focus:ring-2 focus:ring-forest/10 aria-invalid:!border-red-600 aria-invalid:!ring-1 aria-invalid:!ring-red-600/20 aria-invalid:focus:!border-red-700 aria-invalid:focus:!ring-2 aria-invalid:focus:!ring-red-600/20'

function ProjectEditForm({
  project,
  isSaving,
  serverError,
  onCancel,
  onClearError,
  onSave,
}: {
  project: Project
  isSaving: boolean
  serverError: string | null
  onCancel: () => void
  onClearError: () => void
  onSave: (projectId: string, values: ProjectFormValues) => Promise<void>
}) {
  const [name, setName] = useState(project.name)
  const [code, setCode] = useState(project.code)
  const [errors, setErrors] = useState<FieldErrors<keyof ProjectFormValues>>({})

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const validation = projectFormSchema.safeParse({ name, code })

    if (!validation.success) {
      setErrors(fieldErrorsFromZod<keyof ProjectFormValues>(validation.error))
      return
    }

    setErrors({})
    void onSave(project.id, validation.data)
  }

  return (
    <form noValidate autoComplete="off" onSubmit={submit}>
      <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/80">
        Project directory
      </p>
      <DialogTitle className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
        Edit project
      </DialogTitle>
      <Description className="mt-2 text-sm leading-6 font-medium text-ink/80">
        Update the project name and code for this workspace.
      </Description>

      {serverError && (
        <NotificationBanner tone="error" className="mt-5">
          {serverError}
        </NotificationBanner>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
          <Label>Project name</Label>
          <Input
            autoFocus
            autoComplete="off"
            required
            maxLength={160}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setErrors((current) => ({ ...current, name: undefined }))
              onClearError()
            }}
            aria-invalid={Boolean(errors.name)}
            data-validation-error={Boolean(errors.name) || undefined}
            aria-describedby={errors.name ? 'edit-project-name-error' : undefined}
            className={fieldClassName}
          />
          <FieldError id="edit-project-name-error" message={errors.name} />
        </Field>

        <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
          <Label>Project code</Label>
          <Input
            autoComplete="off"
            required
            maxLength={32}
            value={code}
            onChange={(event) => {
              setCode(projectCode(event.target.value))
              setErrors((current) => ({ ...current, code: undefined }))
              onClearError()
            }}
            aria-invalid={Boolean(errors.code)}
            data-validation-error={Boolean(errors.code) || undefined}
            aria-describedby={errors.code ? 'edit-project-code-error' : undefined}
            className={fieldClassName + ' font-mono'}
          />
          <FieldError id="edit-project-code-error" message={errors.code} />
        </Field>
      </div>

      <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          disabled={isSaving}
          onClick={onCancel}
          className="h-10 border border-ink/15 bg-white px-4 text-sm font-bold text-ink transition hover:bg-cream disabled:opacity-50"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSaving}
          aria-busy={isSaving}
          className="inline-flex h-10 items-center justify-center gap-2 bg-ink px-4 text-sm font-bold text-white transition hover:bg-forest disabled:cursor-wait disabled:opacity-60"
        >
          {isSaving && <ButtonSpinner tone="light" />}
          {isSaving ? 'Saving project…' : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}

function SubcontractorEditForm({
  subcontractor,
  isSaving,
  serverError,
  onCancel,
  onClearError,
  onSave,
}: {
  subcontractor: Subcontractor
  isSaving: boolean
  serverError: string | null
  onCancel: () => void
  onClearError: () => void
  onSave: (
    subcontractorId: string,
    values: SubcontractorFormValues,
  ) => Promise<void>
}) {
  const [companyName, setCompanyName] = useState(subcontractor.company_name)
  const [contactName, setContactName] = useState(subcontractor.contact_name ?? '')
  const [email, setEmail] = useState(subcontractor.email ?? '')
  const [errors, setErrors] = useState<
    FieldErrors<keyof SubcontractorFormValues>
  >({})

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const validation = subcontractorFormSchema.safeParse({
      companyName,
      contactName,
      email,
    })

    if (!validation.success) {
      setErrors(
        fieldErrorsFromZod<keyof SubcontractorFormValues>(validation.error),
      )
      return
    }

    setErrors({})
    void onSave(subcontractor.id, validation.data)
  }

  return (
    <form noValidate autoComplete="off" onSubmit={submit}>
      <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/80">
        Subcontractor directory
      </p>
      <DialogTitle className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
        Edit subcontractor
      </DialogTitle>
      <Description className="mt-2 text-sm leading-6 font-medium text-ink/80">
        Update the company and optional contact details for this workspace.
      </Description>

      {serverError && (
        <NotificationBanner tone="error" className="mt-5">
          {serverError}
        </NotificationBanner>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field className="flex flex-col gap-2 text-sm font-bold text-ink sm:col-span-2">
          <Label>Company name</Label>
          <Input
            autoFocus
            autoComplete="off"
            required
            maxLength={160}
            value={companyName}
            onChange={(event) => {
              setCompanyName(event.target.value)
              setErrors((current) => ({ ...current, companyName: undefined }))
              onClearError()
            }}
            aria-invalid={Boolean(errors.companyName)}
            data-validation-error={Boolean(errors.companyName) || undefined}
            aria-describedby={
              errors.companyName ? 'edit-subcontractor-company-error' : undefined
            }
            className={fieldClassName}
          />
          <FieldError
            id="edit-subcontractor-company-error"
            message={errors.companyName}
          />
        </Field>

        <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
          <span className="flex items-center justify-between gap-3">
            <Label>Contact name</Label>
            <span className="text-[11px] font-medium text-ink/65">Optional</span>
          </span>
          <Input
            autoComplete="off"
            maxLength={160}
            value={contactName}
            onChange={(event) => {
              setContactName(event.target.value)
              setErrors((current) => ({ ...current, contactName: undefined }))
              onClearError()
            }}
            aria-invalid={Boolean(errors.contactName)}
            data-validation-error={Boolean(errors.contactName) || undefined}
            aria-describedby={
              errors.contactName ? 'edit-subcontractor-contact-error' : undefined
            }
            className={fieldClassName}
          />
          <FieldError
            id="edit-subcontractor-contact-error"
            message={errors.contactName}
          />
        </Field>

        <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
          <span className="flex items-center justify-between gap-3">
            <Label>Email</Label>
            <span className="text-[11px] font-medium text-ink/65">Optional</span>
          </span>
          <Input
            autoComplete="off"
            type="email"
            maxLength={320}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
              setErrors((current) => ({ ...current, email: undefined }))
              onClearError()
            }}
            aria-invalid={Boolean(errors.email)}
            data-validation-error={Boolean(errors.email) || undefined}
            aria-describedby={
              errors.email ? 'edit-subcontractor-email-error' : undefined
            }
            className={fieldClassName}
          />
          <FieldError id="edit-subcontractor-email-error" message={errors.email} />
        </Field>
      </div>

      <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          disabled={isSaving}
          onClick={onCancel}
          className="h-10 border border-ink/15 bg-white px-4 text-sm font-bold text-ink transition hover:bg-cream disabled:opacity-50"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSaving}
          aria-busy={isSaving}
          className="inline-flex h-10 items-center justify-center gap-2 bg-ink px-4 text-sm font-bold text-white transition hover:bg-forest disabled:cursor-wait disabled:opacity-60"
        >
          {isSaving && <ButtonSpinner tone="light" />}
          {isSaving ? 'Saving subcontractor…' : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}

export function DirectoryEditDialog({
  target,
  isSaving,
  serverError,
  onClose,
  onClearError,
  onSaveProject,
  onSaveSubcontractor,
}: DirectoryEditDialogProps) {
  return (
    <Dialog
      open={target !== null}
      onClose={() => {
        if (!isSaving) onClose()
      }}
      className="relative z-50"
    >
      <DialogBackdrop className="fixed inset-0 bg-ink/55 backdrop-blur-sm" />
      <div className="fixed inset-0 grid place-items-center overflow-y-auto p-4 sm:p-6">
        <DialogPanel className="w-full max-w-2xl border border-ink/15 bg-white p-6 shadow-[0_24px_64px_rgba(19,37,31,0.22)] sm:p-8">
          {target?.kind === 'project' && (
            <ProjectEditForm
              key={target.record.id}
              project={target.record}
              isSaving={isSaving}
              serverError={serverError}
              onCancel={onClose}
              onClearError={onClearError}
              onSave={onSaveProject}
            />
          )}
          {target?.kind === 'subcontractor' && (
            <SubcontractorEditForm
              key={target.record.id}
              subcontractor={target.record}
              isSaving={isSaving}
              serverError={serverError}
              onCancel={onClose}
              onClearError={onClearError}
              onSave={onSaveSubcontractor}
            />
          )}
        </DialogPanel>
      </div>
    </Dialog>
  )
}
