import { Button, Field, Input, Label } from '@headlessui/react'
import type { FormEvent, MouseEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { ButtonSpinner } from '@/components/ui/ButtonSpinner'
import { FieldError } from '@/components/ui/FieldError'
import { NotificationBanner } from '@/components/ui/NotificationBanner'
import { supabase } from '@/lib/supabase'
import {
  fieldErrorsFromZod,
  type FieldErrors,
} from '@/lib/validation'
import {
  authCredentialsSchema,
  passwordResetRequestSchema,
  passwordUpdateSchema,
  type AuthCredentials,
  type PasswordResetRequest,
  type PasswordUpdate,
} from '@/features/auth/auth.schemas'

type AuthMode =
  | 'sign-in'
  | 'sign-up'
  | 'forgot-password'
  | 'reset-password'
type AuthField =
  | keyof AuthCredentials
  | keyof PasswordResetRequest
  | keyof PasswordUpdate

const authContent: Record<
  AuthMode,
  { title: string; description: string; submitLabel: string }
> = {
  'sign-in': {
    title: 'Welcome back.',
    description: 'Sign in with your organization email to continue.',
    submitLabel: 'Sign in securely',
  },
  'sign-up': {
    title: 'Create your account.',
    description: 'Set up your credentials to join your organization workspace.',
    submitLabel: 'Create your account',
  },
  'forgot-password': {
    title: 'Reset your password.',
    description: 'Enter your email and we’ll send you a secure reset link.',
    submitLabel: 'Send reset link',
  },
  'reset-password': {
    title: 'Choose a new password.',
    description: 'Enter and confirm the new password for your account.',
    submitLabel: 'Update password',
  },
}

const platformFeatures = [
  {
    name: 'Secure access',
    description: 'Protected identity and sessions',
  },
  {
    name: 'Data isolation',
    description: 'Tenant isolation at the data layer',
  },
  {
    name: 'Secure checkout',
    description: 'Protected payment handoff',
  },
]

function authModeFromLocation(): AuthMode {
  const auth = new URLSearchParams(window.location.search).get('auth')

  if (auth === 'create-account') return 'sign-up'
  if (auth === 'forgot-password') return 'forgot-password'
  if (auth === 'reset-password') return 'reset-password'
  return 'sign-in'
}

function authModeHref(mode: AuthMode): string {
  const url = new URL(window.location.href)

  url.searchParams.delete('auth')
  url.searchParams.delete('code')
  url.hash = ''

  if (mode === 'sign-up') {
    url.searchParams.set('auth', 'create-account')
  } else if (mode !== 'sign-in') {
    url.searchParams.set('auth', mode)
  }

  return `${url.pathname}${url.search}${url.hash}`
}

function passwordResetRedirectUrl(): string {
  return new URL(authModeHref('reset-password'), window.location.origin).toString()
}

function recoveryErrorFromLocation(): string | null {
  if (authModeFromLocation() !== 'reset-password') return null

  const hash = new URLSearchParams(window.location.hash.slice(1))
  return hash.get('error_description')
}

interface PasswordFieldProps {
  id: string
  label: string
  value: string
  error?: string
  isVisible: boolean
  autoComplete: 'current-password' | 'new-password'
  placeholder: string
  aside?: ReactNode
  onChange: (value: string) => void
  onToggleVisibility: () => void
}

function PasswordField({
  id,
  label,
  value,
  error,
  isVisible,
  autoComplete,
  placeholder,
  aside,
  onChange,
  onToggleVisibility,
}: PasswordFieldProps) {
  const errorId = `${id}-error`

  return (
    <Field className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={id} className="text-[13px] font-bold text-ink">
          {label}
        </Label>
        {aside}
      </div>
      <div
        data-validation-error={Boolean(error) || undefined}
        className={
          'flex h-10 items-center border bg-white transition focus-within:ring-2 ' +
          (error
            ? '!border-red-600 !ring-1 !ring-red-600/20 focus-within:!border-red-700 focus-within:!ring-2 focus-within:!ring-red-600/20'
            : 'border-ink/18 focus-within:border-forest focus-within:ring-forest/10')
        }
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="ml-3.5 size-4 shrink-0 text-forest/60"
        >
          <rect x="4.5" y="10" width="15" height="10" />
          <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
        </svg>
        <Input
          id={id}
          type={isVisible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          minLength={8}
          required
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-sm font-medium text-ink outline-none placeholder:text-ink/50"
          placeholder={placeholder}
        />
        <Button
          type="button"
          onClick={onToggleVisibility}
          aria-label={isVisible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={isVisible}
          className="mr-1 inline-flex size-8 items-center justify-center text-ink/55 transition hover:bg-cream hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-forest"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="size-4"
          >
            {isVisible ? (
              <>
                <path d="M3 3l18 18" />
                <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
                <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c5.5 0 9 7 9 7a16.5 16.5 0 0 1-2.2 3.2M6.6 6.6C4.3 8.1 3 12 3 12s3.5 7 9 7c1.4 0 2.7-.4 3.8-1" />
              </>
            ) : (
              <>
                <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z" />
                <circle cx="12" cy="12" r="2.5" />
              </>
            )}
          </svg>
        </Button>
      </div>
      <FieldError id={errorId} message={error} />
    </Field>
  )
}

export function AuthCard() {
  const [mode, setMode] = useState<AuthMode>(authModeFromLocation)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(recoveryErrorFromLocation)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<AuthField>>({})

  useEffect(() => {
    const handlePopState = () => {
      setMode(authModeFromLocation())
      setError(recoveryErrorFromLocation())
      setMessage(null)
      setShowPassword(false)
      setShowConfirmPassword(false)
      setPassword('')
      setConfirmPassword('')
      setFieldErrors({})
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setMessage(null)

    if (mode === 'forgot-password') {
      const validation = passwordResetRequestSchema.safeParse({ email })

      if (!validation.success) {
        setFieldErrors(fieldErrorsFromZod<AuthField>(validation.error))
        return
      }

      setFieldErrors({})
      setIsSubmitting(true)

      const result = await supabase.auth.resetPasswordForEmail(
        validation.data.email,
        { redirectTo: passwordResetRedirectUrl() },
      )

      if (result.error) {
        setError(result.error.message)
      } else {
        setMessage(
          'If an account exists for that email, a password reset link has been sent.',
        )
      }

      setIsSubmitting(false)
      return
    }

    if (mode === 'reset-password') {
      const validation = passwordUpdateSchema.safeParse({
        password,
        confirmPassword,
      })

      if (!validation.success) {
        setFieldErrors(fieldErrorsFromZod<AuthField>(validation.error))
        return
      }

      setFieldErrors({})
      setIsSubmitting(true)

      const result = await supabase.auth.updateUser({
        password: validation.data.password,
      })

      if (result.error) {
        setError(
          result.error.message ||
            'This reset link is invalid or expired. Request a new one.',
        )
        setIsSubmitting(false)
        return
      }

      window.location.replace(authModeHref('sign-in'))
      return
    }

    const validation = authCredentialsSchema.safeParse({ email, password })

    if (!validation.success) {
      setFieldErrors(fieldErrorsFromZod<AuthField>(validation.error))
      return
    }

    setFieldErrors({})
    setIsSubmitting(true)

    const result =
      mode === 'sign-in'
        ? await supabase.auth.signInWithPassword(validation.data)
        : await supabase.auth.signUp({
            ...validation.data,
            options: { emailRedirectTo: window.location.origin },
          })

    if (result.error) {
      setError(result.error.message)
    } else if (mode === 'sign-up' && !result.data.session) {
      setMessage('Check your email to confirm your account, then sign in.')
    }

    setIsSubmitting(false)
  }

  function changeMode(nextMode: AuthMode) {
    if (nextMode === mode) return

    window.history.pushState(null, '', authModeHref(nextMode))
    setMode(nextMode)
    setError(null)
    setMessage(null)
    setShowPassword(false)
    setShowConfirmPassword(false)
    setPassword('')
    setConfirmPassword('')
    setFieldErrors({})
  }

  const alternateMode: AuthMode =
    mode === 'sign-in' ? 'sign-up' : 'sign-in'
  const content = authContent[mode]

  function followAuthLink(
    event: MouseEvent<HTMLAnchorElement>,
    nextMode: AuthMode,
  ) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    event.preventDefault()
    changeMode(nextMode)
  }

  return (
    <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-10 lg:min-h-[calc(100vh-9.5rem)] lg:grid-cols-[1.02fr_0.98fr] lg:px-8 lg:py-12">
      <div className="order-2 flex max-w-xl flex-col gap-7 lg:order-1">
        <div className="inline-flex w-fit items-center gap-2 border border-forest/15 bg-white/75 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.17em] text-forest shadow-[0_6px_18px_rgba(19,37,31,0.05)] backdrop-blur">
          <span className="size-1.5 rounded-full bg-lime-500" />
          Multi-tenant operations
        </div>
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl leading-[1.02] font-extrabold tracking-[-0.045em] text-ink sm:text-5xl lg:text-[3.5rem]">
            Financial workflows with
            <span className="text-forest"> tenant-safe boundaries.</span>
          </h1>
          <p className="max-w-lg text-base leading-7 font-medium text-ink/85">
            Sign in to manage projects, subcontractors, retainage-aware payment
            requests, and an immutable audit history.
          </p>
        </div>
        <div className="grid border-y border-ink/12 sm:grid-cols-3 sm:divide-x sm:divide-ink/12">
          {platformFeatures.map((feature, index) => (
            <div
              key={feature.name}
              className="flex gap-3 border-b border-ink/10 py-4 last:border-b-0 sm:border-b-0 sm:px-4 sm:first:pl-0 sm:last:pr-0"
            >
              <span className="pt-0.5 font-mono text-[10px] font-bold text-forest/70">
                0{index + 1}
              </span>
              <span className="flex flex-col gap-1">
                <span className="text-sm font-bold text-ink">{feature.name}</span>
                <span className="text-xs leading-4 font-medium text-ink/65">
                  {feature.description}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="order-1 mx-auto w-full max-w-[31rem] border border-ink/10 bg-white shadow-[0_28px_72px_rgba(19,37,31,0.14)] lg:order-2">
        <div className="p-7 sm:p-9">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-forest/75">
                Secure workspace
              </p>
              <span className="inline-flex h-8 items-center gap-2 border border-ink/10 bg-cream/65 px-3 text-[11px] font-semibold text-ink/75">
                <svg
                  viewBox="0 0 20 20"
                  className="size-3.5 text-forest"
                  aria-hidden="true"
                >
                  <path
                    fill="currentColor"
                    fillRule="evenodd"
                    d="M10 1.75a4.25 4.25 0 0 0-4.25 4.25v1.25A2.75 2.75 0 0 0 3 10v5.5a2.75 2.75 0 0 0 2.75 2.75h8.5A2.75 2.75 0 0 0 17 15.5V10a2.75 2.75 0 0 0-2.75-2.75V6A4.25 4.25 0 0 0 10 1.75Zm2.75 5.5V6a2.75 2.75 0 1 0-5.5 0v1.25h5.5Z"
                    clipRule="evenodd"
                  />
                </svg>
                Secure session
              </span>
            </div>
            <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-ink">
              {content.title}
            </h2>
            <p className="text-sm leading-6 font-medium text-ink/70">
              {content.description}
            </p>
          </div>

          <form
            noValidate
            onSubmit={(event) => void submit(event)}
            className="mt-6 flex flex-col gap-5"
          >
            {mode !== 'reset-password' && (
              <Field className="flex flex-col gap-2">
                <Label htmlFor="email" className="text-[13px] font-bold text-ink">
                  Email address
                </Label>
                <div
                  data-validation-error={Boolean(fieldErrors.email) || undefined}
                  className={
                    'flex h-10 items-center border bg-white transition focus-within:ring-2 ' +
                    (fieldErrors.email
                      ? '!border-red-600 !ring-1 !ring-red-600/20 focus-within:!border-red-700 focus-within:!ring-2 focus-within:!ring-red-600/20'
                      : 'border-ink/18 focus-within:border-forest focus-within:ring-forest/10')
                  }
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="ml-3.5 size-4 shrink-0 text-forest/60"
                  >
                    <path d="M3.75 6.75h16.5v10.5H3.75z" />
                    <path d="m4.5 7.5 7.5 5.25 7.5-5.25" />
                  </svg>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value)
                      setFieldErrors((current) => ({
                        ...current,
                        email: undefined,
                      }))
                    }}
                    autoComplete="email"
                    required
                    aria-invalid={Boolean(fieldErrors.email)}
                    aria-describedby={
                      fieldErrors.email ? 'auth-email-error' : undefined
                    }
                    className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-sm font-medium text-ink outline-none placeholder:text-ink/50"
                    placeholder="you@company.com"
                  />
                </div>
                <FieldError id="auth-email-error" message={fieldErrors.email} />
              </Field>
            )}

            {mode !== 'forgot-password' && (
              <PasswordField
                id="auth-password"
                label={mode === 'reset-password' ? 'New password' : 'Password'}
                value={password}
                error={fieldErrors.password}
                isVisible={showPassword}
                autoComplete={
                  mode === 'sign-in' ? 'current-password' : 'new-password'
                }
                placeholder={
                  mode === 'reset-password'
                    ? 'Enter your new password'
                    : 'Enter your password'
                }
                aside={
                  mode === 'sign-in' ? (
                    <a
                      href={authModeHref('forgot-password')}
                      onClick={(event) =>
                        followAuthLink(event, 'forgot-password')
                      }
                      className="text-[11px] font-bold text-forest transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-forest/25"
                    >
                      Forgot password?
                    </a>
                  ) : (
                    <span className="text-[11px] font-semibold text-ink/55">
                      8 characters minimum
                    </span>
                  )
                }
                onChange={(value) => {
                  setPassword(value)
                  setFieldErrors((current) => ({
                    ...current,
                    password: undefined,
                  }))
                }}
                onToggleVisibility={() =>
                  setShowPassword((isVisible) => !isVisible)
                }
              />
            )}

            {mode === 'reset-password' && (
              <PasswordField
                id="auth-confirm-password"
                label="Confirm new password"
                value={confirmPassword}
                error={fieldErrors.confirmPassword}
                isVisible={showConfirmPassword}
                autoComplete="new-password"
                placeholder="Repeat your new password"
                onChange={(value) => {
                  setConfirmPassword(value)
                  setFieldErrors((current) => ({
                    ...current,
                    confirmPassword: undefined,
                  }))
                }}
                onToggleVisibility={() =>
                  setShowConfirmPassword((isVisible) => !isVisible)
                }
              />
            )}

            {error && (
              <NotificationBanner tone="error">{error}</NotificationBanner>
            )}
            {message && (
              <NotificationBanner tone="success">{message}</NotificationBanner>
            )}

            <Button
              type="submit"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
              className="inline-flex h-10 items-center justify-center gap-2 bg-ink px-5 text-sm font-bold text-white shadow-[0_10px_24px_rgba(19,37,31,0.18)] transition hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-wait disabled:opacity-60"
            >
              {isSubmitting ? (
                <ButtonSpinner tone="light" />
              ) : (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="size-4"
                >
                  <path d="M5 12h14M14 7l5 5-5 5" />
                </svg>
              )}
              {isSubmitting ? 'Please wait…' : content.submitLabel}
            </Button>
          </form>

          <div className="mt-6 border-t border-ink/10 pt-5">
            <p className="text-xs leading-5 font-medium text-ink/65">
              Credentials and sessions are protected by managed authentication.
              Your password is never stored by TradeLedger.
            </p>
          </div>

          <p className="mt-5 text-center text-sm font-medium text-ink/70">
            {mode === 'sign-in'
              ? 'New to TradeLedger?'
              : mode === 'sign-up'
                ? 'Already have an account?'
                : 'Remember your password?'}{' '}
            <a
              href={authModeHref(alternateMode)}
              onClick={(event) => followAuthLink(event, alternateMode)}
              className="font-extrabold text-forest transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-forest/25"
            >
              {alternateMode === 'sign-up' ? 'Create account' : 'Sign in'}
            </a>
          </p>
        </div>
      </div>
    </section>
  )
}
