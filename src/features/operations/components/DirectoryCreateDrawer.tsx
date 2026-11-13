import {
  Button,
  Description,
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
import {
  SidePanel,
  SidePanelCloseButton,
} from '../../../components/ui/SidePanel'
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

export type DirectoryCreateTarget = 'project' | 'subcontractor'

interface DirectoryCreateDrawerProps {
  target: DirectoryCreateTarget | null
  isSaving: boolean
  serverError: string | null
  onClose: () => void
  onClearError: () => void
  onCreateProject: (values: ProjectFormValues) => Promise<void>
  onCreateSubcontractor: (values: SubcontractorFormValues) => Promise<void>
}

const fieldClassName =
  'h-10 border border-ink/15 bg-white px-3.5 text-sm font-medium text-ink outline-none transition placeholder:text-ink/60 focus:border-forest focus:ring-2 focus:ring-forest/10 aria-invalid:!border-red-600 aria-invalid:!ring-1 aria-invalid:!ring-red-600/20 aria-invalid:focus:!border-red-700 aria-invalid:focus:!ring-2 aria-invalid:focus:!ring-red-600/20'

function ProjectCreateForm({
  isSaving,
  serverError,
  onCancel,
  onClearError,
  onCreate,
}: {
  isSaving: boolean
  serverError: string | null
  onCancel: () => void
  onClearError: () => void
  onCreate: (values: ProjectFormValues) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState<FieldErrors<keyof ProjectFormValues>>({})

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const validation = projectFormSchema.safeParse({
      name,
      code: projectCode(code || name),
    })

    if (!validation.success) {
      setErrors(fieldErrorsFromZod<keyof ProjectFormValues>(validation.error))
      return
    }

    setErrors({})
    void onCreate(validation.data)
  }

  return (
    <form noValidate autoComplete="off" onSubmit={submit} className="flex min-h-full flex-col">
      <SidePanelCloseButton disabled={isSaving} onClick={onCancel} />
      <div className="flex flex-1 flex-col gap-6 p-6 pt-16 sm:p-8 sm:pt-20">
        <div className="pr-10">
          <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/80">
            Project directory
          </p>
          <DialogTitle className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
            Add project
          </DialogTitle>
          <Description className="mt-2 text-sm leading-6 font-medium text-ink/80">
            Create a project inside the current workspace boundary.
          </Description>
        </div>

        {serverError && (
          <NotificationBanner tone="error">{serverError}</NotificationBanner>
        )}

        <div className="flex flex-col gap-4">
          <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
            <Label>Project name</Label>
            <Input
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
              aria-describedby={errors.name ? 'create-project-name-error' : undefined}
              placeholder="Cedar Kitchen Remodel"
              className={fieldClassName}
            />
            <FieldError id="create-project-name-error" message={errors.name} />
          </Field>

          <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
            <Label>Project code</Label>
            <Input
              autoComplete="off"
              maxLength={32}
              value={code}
              onChange={(event) => {
                setCode(projectCode(event.target.value))
                setErrors((current) => ({ ...current, code: undefined }))
                onClearError()
              }}
              aria-invalid={Boolean(errors.code)}
              data-validation-error={Boolean(errors.code) || undefined}
              aria-describedby={errors.code ? 'create-project-code-error' : undefined}
              placeholder="CEDAR-01"
              className={fieldClassName + ' font-mono'}
            />
            <FieldError id="create-project-code-error" message={errors.code} />
          </Field>
        </div>
      </div>

      <div className="sticky bottom-0 z-10 flex flex-col-reverse gap-3 border-t border-ink/10 bg-white p-4 sm:flex-row sm:justify-end sm:p-6">
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
          {isSaving ? 'Adding project…' : 'Add project'}
        </Button>
      </div>
    </form>
  )
}

function SubcontractorCreateForm({
  isSaving,
  serverError,
  onCancel,
  onClearError,
  onCreate,
}: {
  isSaving: boolean
  serverError: string | null
  onCancel: () => void
  onClearError: () => void
  onCreate: (values: SubcontractorFormValues) => Promise<void>
}) {
  const [companyName, setCompanyName] = useState('')
  const [contactName, setContactName] = useState('')
  const [email, setEmail] = useState('')
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
    void onCreate(validation.data)
  }

  return (
    <form noValidate autoComplete="off" onSubmit={submit} className="flex min-h-full flex-col">
      <SidePanelCloseButton disabled={isSaving} onClick={onCancel} />
      <div className="flex flex-1 flex-col gap-6 p-6 pt-16 sm:p-8 sm:pt-20">
        <div className="pr-10">
          <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-forest/80">
            Subcontractor directory
          </p>
          <DialogTitle className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-ink">
            Add subcontractor
          </DialogTitle>
          <Description className="mt-2 text-sm leading-6 font-medium text-ink/80">
            Add a company and optional contact details to this workspace.
          </Description>
        </div>

        {serverError && (
          <NotificationBanner tone="error">{serverError}</NotificationBanner>
        )}

        <div className="flex flex-col gap-4">
          <Field className="flex flex-col gap-2 text-sm font-bold text-ink">
            <Label>Company name</Label>
            <Input
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
                errors.companyName
                  ? 'create-subcontractor-company-error'
                  : undefined
              }
              placeholder="Fine Finish Carpentry"
              className={fieldClassName}
            />
            <FieldError
              id="create-subcontractor-company-error"
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
                errors.contactName
                  ? 'create-subcontractor-contact-error'
                  : undefined
              }
              placeholder="Hector Ramirez"
              className={fieldClassName}
            />
            <FieldError
              id="create-subcontractor-contact-error"
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
                errors.email ? 'create-subcontractor-email-error' : undefined
              }
              placeholder="hector@example.com"
              className={fieldClassName}
            />
            <FieldError
              id="create-subcontractor-email-error"
              message={errors.email}
            />
          </Field>
        </div>
      </div>

      <div className="sticky bottom-0 z-10 flex flex-col-reverse gap-3 border-t border-ink/10 bg-white p-4 sm:flex-row sm:justify-end sm:p-6">
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
          {isSaving ? 'Adding subcontractor…' : 'Add subcontractor'}
        </Button>
      </div>
    </form>
  )
}

export function DirectoryCreateDrawer({
  target,
  isSaving,
  serverError,
  onClose,
  onClearError,
  onCreateProject,
  onCreateSubcontractor,
}: DirectoryCreateDrawerProps) {
  return (
    <SidePanel open={target !== null} busy={isSaving} onClose={onClose}>
      {target === 'project' && (
        <ProjectCreateForm
          key="create-project"
          isSaving={isSaving}
          serverError={serverError}
          onCancel={onClose}
          onClearError={onClearError}
          onCreate={onCreateProject}
        />
      )}
      {target === 'subcontractor' && (
        <SubcontractorCreateForm
          key="create-subcontractor"
          isSaving={isSaving}
          serverError={serverError}
          onCancel={onClose}
          onClearError={onClearError}
          onCreate={onCreateSubcontractor}
        />
      )}
    </SidePanel>
  )
}
