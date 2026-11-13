import { Button, Field, Input, Label, Radio, RadioGroup } from '@headlessui/react'
import type { FormEvent } from 'react'
import { useState } from 'react'

import { supabase } from '../../../lib/supabase'

type AuthMode = 'sign-in' | 'sign-up'

export function AuthCard() {
  const [mode, setMode] = useState<AuthMode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    setIsSubmitting(true)

    const result =
      mode === 'sign-in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
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
    setMode(nextMode)
    setError(null)
    setMessage(null)
  }

  return (
    <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-10 lg:min-h-[calc(100vh-10rem)] lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-16">
      <div className="flex max-w-xl flex-col gap-8">
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
        <div className="grid gap-4 sm:grid-cols-3">
          {['Supabase Auth', 'PostgreSQL RLS', 'Stripe Checkout'].map(
            (feature, index) => (
              <div
                key={feature}
                className="flex items-center gap-3 border-t border-ink/12 pt-4"
              >
                <span className="font-mono text-[11px] font-bold text-forest/80">
                  0{index + 1}
                </span>
                <span className="text-sm font-bold text-ink/85">{feature}</span>
              </div>
            ),
          )}
        </div>
      </div>

      <div className="border border-ink/10 bg-white p-7 shadow-[0_24px_64px_rgba(19,37,31,0.12)] sm:p-9">
        <RadioGroup
          value={mode}
          onChange={changeMode}
          aria-label="Authentication mode"
          className="flex border border-ink/6 bg-cream p-1"
        >
          {(['sign-in', 'sign-up'] as const).map((option) => (
            <Radio
              key={option}
              value={option}
              className="flex-1 cursor-pointer px-4 py-2 text-center text-sm font-bold text-ink/80 transition hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-forest/25 data-checked:bg-white data-checked:text-ink data-checked:shadow-sm"
            >
              {option === 'sign-in' ? 'Sign in' : 'Create account'}
            </Radio>
          ))}
        </RadioGroup>

        <form onSubmit={(event) => void submit(event)} className="mt-7 flex flex-col gap-5">
          <Field className="flex flex-col gap-2">
            <Label htmlFor="email" className="text-[13px] font-bold text-ink/85">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              className="h-10 border border-ink/15 bg-white px-3.5 text-sm font-medium text-ink outline-none transition placeholder:text-ink/60 focus:border-forest focus:ring-2 focus:ring-forest/10"
              placeholder="you@example.com"
            />
          </Field>

          <Field className="flex flex-col gap-2">
            <Label htmlFor="password" className="text-[13px] font-bold text-ink/85">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              minLength={8}
              required
              className="h-10 border border-ink/15 bg-white px-3.5 text-sm font-medium text-ink outline-none transition placeholder:text-ink/60 focus:border-forest focus:ring-2 focus:ring-forest/10"
              placeholder="At least 8 characters"
            />
          </Field>

          {error && (
            <p
              role="alert"
              className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              {error}
            </p>
          )}
          {message && (
            <p
              role="status"
              className="border border-lime-200 bg-lime-50 px-4 py-3 text-sm text-lime-900"
            >
              {message}
            </p>
          )}

          <Button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex h-10 items-center justify-center bg-ink px-5 text-sm font-bold text-white shadow-[0_10px_24px_rgba(19,37,31,0.18)] transition hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-wait disabled:opacity-60"
          >
            {isSubmitting
              ? 'Please wait…'
              : mode === 'sign-in'
                ? 'Sign in securely'
                : 'Create your account'}
          </Button>
        </form>
      </div>
    </section>
  )
}
