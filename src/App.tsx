import { lazy, Suspense } from 'react'

import { Header } from './components/layout/Header'
import { AuthCard } from './features/auth/components/AuthCard'
import { useAuth } from './features/auth/hooks/useAuth'

const CheckoutCanceled = lazy(() =>
  import('./features/checkout/components/CheckoutCanceled').then((module) => ({
    default: module.CheckoutCanceled,
  })),
)
const CheckoutCard = lazy(() =>
  import('./features/checkout/components/CheckoutCard').then((module) => ({
    default: module.CheckoutCard,
  })),
)
const PaymentResult = lazy(() =>
  import('./features/checkout/components/PaymentResult').then((module) => ({
    default: module.PaymentResult,
  })),
)
const Workspace = lazy(() =>
  import('./features/workspace/components/Workspace').then((module) => ({
    default: module.Workspace,
  })),
)

function PageLoader() {
  return (
    <div className="grid min-h-[68vh] place-items-center px-6">
      <div className="flex items-center gap-3 text-sm font-semibold text-forest">
        <span className="size-5 animate-spin rounded-full border-2 border-forest/15 border-t-forest" />
        Loading secure workspace…
      </div>
    </div>
  )
}

export default function App() {
  const { isReady, session } = useAuth()
  const search = new URLSearchParams(window.location.search)
  const checkoutState = search.get('checkout')
  const sessionId = search.get('session_id')
  const isCheckoutDemo = search.get('demo') === 'checkout'
  const isDashboard = Boolean(
    isReady &&
      session &&
      checkoutState !== 'success' &&
      checkoutState !== 'canceled' &&
      !isCheckoutDemo,
  )

  return (
    <div
      className={
        'relative isolate min-h-screen ' +
        (isDashboard ? '' : 'overflow-hidden bg-cream')
      }
    >
      {!isDashboard && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[34rem] bg-[radial-gradient(circle_at_top_left,_rgba(216,247,143,0.54),_transparent_52%)]" />
          <Header session={session} />
        </>
      )}

      <main>
        <Suspense fallback={<PageLoader />}>
          {!isReady ? (
            <PageLoader />
          ) : !session ? (
            <AuthCard />
          ) : checkoutState === 'success' && sessionId ? (
            <PaymentResult sessionId={sessionId} />
          ) : checkoutState === 'canceled' ? (
            <CheckoutCanceled />
          ) : isCheckoutDemo ? (
            <CheckoutCard />
          ) : (
            <Workspace session={session} />
          )}
        </Suspense>
      </main>

      {!isDashboard && (
        <footer className="mx-auto flex w-full max-w-7xl flex-col gap-2 border-t border-ink/8 px-6 py-7 text-xs font-medium text-ink/80 sm:flex-row sm:items-center sm:justify-between lg:px-8">
          <p>Tenant boundaries are enforced by PostgreSQL Row-Level Security.</p>
          <p>React × Supabase × Stripe</p>
        </footer>
      )}
    </div>
  )
}
