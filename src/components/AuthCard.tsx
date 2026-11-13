import type { FormEvent } from 'react'
import { useState } from 'react'

import { supabase } from '../lib/supabase'

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
    <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-6 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-20">
      <div className="flex max-w-xl flex-col gap-7">
        <div className="inline-flex w-fit items-center gap-2 border border-forest/15 bg-white/70 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.16em] text-forest shadow-sm backdrop-blur">
          <span className="size-2 rounded-full bg-lime-500" />
          Multi-tenant operations
        </div>
        <div className="flex flex-col gap-4">
          <h1 className="text-5xl leading-[0.98] font-black tracking-[-0.045em] text-ink sm:text-6xl">
            Financial workflows with
            <span className="text-forest"> tenant-safe boundaries.</span>
          </h1>
          <p className="max-w-lg text-base leading-7 text-ink/60">
            Sign in to manage projects, subcontractors, retainage-aware payment
            requests, and an immutable audit history.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {['Supabase Auth', 'PostgreSQL RLS', 'Stripe Checkout'].map(
            (feature, index) => (
              <div
                key={feature}
                className="flex items-center gap-3 border-t border-ink/15 pt-4"
              >
                <span className="font-mono text-xs font-bold text-forest/50">
                  0{index + 1}
                </span>
                <span className="text-sm font-semibold text-ink">{feature}</span>
              </div>
            ),
          )}
        </div>
      </div>

      <div className="border border-ink/10 bg-white p-7 shadow-[0_32px_80px_rgba(16,35,31,0.14)] sm:p-10">
        <div className="flex bg-cream p-1">
          {(['sign-in', 'sign-up'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => changeMode(option)}
              className={
                'flex-1 px-4 py-2.5 text-sm font-bold transition ' +
                (mode === option
                  ? 'bg-white text-ink shadow-sm'
                  : 'text-ink/50 hover:text-ink')
              }
            >
              {option === 'sign-in' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>

        <form onSubmit={(event) => void submit(event)} className="mt-8 flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label htmlFor="email" className="text-sm font-bold text-ink">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              className="h-12 border border-ink/15 bg-cream/60 px-4 text-sm text-ink outline-none transition placeholder:text-ink/30 focus:border-forest focus:ring-2 focus:ring-forest/10"
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="password" className="text-sm font-bold text-ink">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              minLength={8}
              required
              className="h-12 border border-ink/15 bg-cream/60 px-4 text-sm text-ink outline-none transition placeholder:text-ink/30 focus:border-forest focus:ring-2 focus:ring-forest/10"
              placeholder="At least 8 characters"
            />
          </div>

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

          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex h-13 items-center justify-center bg-ink px-6 text-sm font-bold text-white shadow-[0_14px_32px_rgba(16,35,31,0.2)] transition hover:-translate-y-0.5 hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-wait disabled:translate-y-0 disabled:opacity-60"
          >
            {isSubmitting
              ? 'Please wait…'
              : mode === 'sign-in'
                ? 'Sign in securely'
                : 'Create your account'}
          </button>
        </form>
      </div>
    </section>
  )
}
