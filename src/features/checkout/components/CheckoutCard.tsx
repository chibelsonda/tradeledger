import { Button, Field, Input, Label } from '@headlessui/react'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { useMemo, useState } from 'react'

import { clampQuantity, formatCurrency } from '../../../lib/format'
import { supabase } from '../../../lib/supabase'

const product = {
  name: 'Launch Kit',
  description:
    'A polished starter pack for turning your next idea into a real launch.',
  unitAmount: 4900,
  currency: 'usd',
  maximumQuantity: 10,
} as const

interface CreateCheckoutResponse {
  url: string
}

async function checkoutErrorMessage(error: Error): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body: unknown = await error.context.json().catch(() => null)

    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string'
    ) {
      return body.error
    }
  }

  return 'Checkout is temporarily unavailable. Please try again.'
}

export function CheckoutCard() {
  const [quantity, setQuantity] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const total = useMemo(
    () => formatCurrency(product.unitAmount * quantity, product.currency),
    [quantity],
  )

  function updateQuantity(nextQuantity: number) {
    setQuantity(clampQuantity(nextQuantity, 1, product.maximumQuantity))
  }

  async function startCheckout() {
    setError(null)
    setIsSubmitting(true)

    const { data, error: functionError } =
      await supabase.functions.invoke<CreateCheckoutResponse>(
        'create-checkout',
        { body: { quantity } },
      )

    if (functionError) {
      setError(await checkoutErrorMessage(functionError))
      setIsSubmitting(false)
      return
    }

    if (!data?.url) {
      setError('Stripe did not return a checkout URL. Please try again.')
      setIsSubmitting(false)
      return
    }

    window.location.assign(data.url)
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl items-center gap-12 px-6 py-10 lg:min-h-[calc(100vh-10rem)] lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-16">
      <div className="flex max-w-2xl flex-col gap-8">
        <div className="inline-flex w-fit items-center gap-2 border border-forest/15 bg-white/75 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.17em] text-forest shadow-[0_6px_18px_rgba(19,37,31,0.05)] backdrop-blur">
          <span className="size-1.5 rounded-full bg-lime-500" />
          Built for momentum
        </div>

        <div className="flex flex-col gap-5">
          <h1 className="max-w-xl text-4xl leading-[1.02] font-extrabold tracking-[-0.045em] text-ink sm:text-5xl lg:text-[3.75rem]">
            Your next idea deserves a{' '}
            <span className="relative inline-block text-forest">
              real launch.
              <svg
                viewBox="0 0 390 18"
                className="absolute -bottom-3 left-0 w-full text-lime-400"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M3 13.5C85 3.7 197 4.1 387 8"
                  stroke="currentColor"
                  strokeWidth="7"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </h1>
          <p className="max-w-lg text-base leading-7 font-medium text-ink/85 sm:text-lg">
            A focused toolkit with the templates, prompts, and checklists you
            need to move from rough concept to launch day.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {['Clear roadmap', 'Proven templates', 'Lifetime access'].map(
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

      <div className="relative mx-auto w-full max-w-xl lg:ml-auto">
        <div className="absolute -top-5 -right-4 -z-10 size-36 rounded-full bg-mint blur-2xl" />
        <div className="absolute -bottom-5 -left-4 -z-10 size-40 rounded-full bg-emerald-200/50 blur-3xl" />

        <div className="overflow-hidden border border-ink/10 bg-white shadow-[0_24px_64px_rgba(19,37,31,0.14)]">
          <div className="relative overflow-hidden bg-forest p-8 text-white sm:p-9">
            <div className="absolute -top-12 -right-12 size-48 rounded-full border-[28px] border-white/5" />
            <div className="absolute right-12 -bottom-16 size-32 rotate-45 bg-mint/10" />

            <div className="relative flex flex-col gap-8">
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-mint/80">
                    Digital toolkit
                  </p>
                  <h2 className="text-3xl font-extrabold tracking-[-0.035em]">
                    {product.name}
                  </h2>
                </div>
                <span className="border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/85 backdrop-blur">
                  Instant access
                </span>
              </div>

              <p className="max-w-md text-sm leading-6 font-medium text-white/80">
                {product.description}
              </p>

              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-white/70">One-time payment</p>
                  <p className="mt-1 text-4xl font-extrabold tracking-[-0.04em]">
                    {formatCurrency(product.unitAmount, product.currency)}
                  </p>
                </div>
                <svg
                  viewBox="0 0 64 64"
                  className="size-14 text-mint"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="32"
                    cy="32"
                    r="29"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray="5 6"
                  />
                  <path
                    d="m22 33 7 7 14-17"
                    stroke="currentColor"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-6 p-8 sm:p-9">
            {error && (
              <div
                role="alert"
                className="border border-red-200 bg-red-50 p-4 text-sm text-red-800"
              >
                {error}
              </div>
            )}

            <div className="flex items-end justify-between gap-6">
              <Field className="flex flex-col gap-2">
                <Label htmlFor="quantity" className="text-[13px] font-bold text-ink/85">
                  Quantity
                </Label>
                <div className="flex items-center overflow-hidden border border-ink/15 bg-white focus-within:border-forest focus-within:ring-2 focus-within:ring-forest/10">
                  <Button
                    type="button"
                    onClick={() => updateQuantity(quantity - 1)}
                    className="grid size-10 place-items-center text-lg font-semibold text-ink/85 transition hover:bg-ink/5 hover:text-ink"
                    aria-label="Decrease quantity"
                  >
                    −
                  </Button>
                  <Input
                    id="quantity"
                    type="number"
                    min="1"
                    max={product.maximumQuantity}
                    value={quantity}
                    onChange={(event) => updateQuantity(event.target.valueAsNumber)}
                    className="h-10 w-11 border-x border-ink/10 bg-white text-center text-sm font-bold outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <Button
                    type="button"
                    onClick={() => updateQuantity(quantity + 1)}
                    className="grid size-10 place-items-center text-lg font-semibold text-ink/85 transition hover:bg-ink/5 hover:text-ink"
                    aria-label="Increase quantity"
                  >
                    +
                  </Button>
                </div>
              </Field>

              <div className="text-right">
                <p className="text-xs font-semibold text-ink/80">Total</p>
                <p className="mt-1 text-2xl font-extrabold tracking-[-0.035em] text-ink">
                  {total}
                </p>
              </div>
            </div>

            <Button
              type="button"
              onClick={() => void startCheckout()}
              disabled={isSubmitting}
              className="group inline-flex h-11 items-center justify-center gap-3 bg-ink px-5 text-sm font-bold text-white shadow-[0_10px_24px_rgba(19,37,31,0.2)] transition hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-wait disabled:opacity-70"
            >
              <span>
                {isSubmitting ? 'Opening Stripe…' : 'Continue to secure checkout'}
              </span>
              <svg
                viewBox="0 0 20 20"
                className="size-5 transition-transform group-hover:translate-x-1"
                aria-hidden="true"
              >
                <path
                  fill="currentColor"
                  fillRule="evenodd"
                  d="M3.25 10a.75.75 0 0 1 .75-.75h10.19l-3.22-3.22a.75.75 0 1 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06l3.22-3.22H4a.75.75 0 0 1-.75-.75Z"
                  clipRule="evenodd"
                />
              </svg>
            </Button>

            <div className="flex items-center justify-center gap-4 text-[11px] font-semibold text-ink/75">
              <span>Private order history</span>
              <span className="size-1 rounded-full bg-ink/20" />
              <span>Powered by Stripe</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
