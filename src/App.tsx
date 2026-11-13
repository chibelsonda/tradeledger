import { AuthCard } from './components/AuthCard'
import { CheckoutCanceled } from './components/CheckoutCanceled'
import { CheckoutCard } from './components/CheckoutCard'
import { Header } from './components/Header'
import { PaymentResult } from './components/PaymentResult'
import { Workspace } from './components/Workspace'
import { useAuth } from './hooks/useAuth'

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
        (isDashboard ? '' : 'overflow-hidden')
      }
    >
      {!isDashboard && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-96 bg-[radial-gradient(circle_at_top_left,_rgba(217,249,157,0.65),_transparent_48%)]" />
          <Header session={session} />
        </>
      )}

      <main>
        {!isReady ? (
          <div className="grid min-h-[68vh] place-items-center px-6">
            <div className="flex items-center gap-3 text-sm font-bold text-forest">
              <span className="size-5 animate-spin rounded-full border-2 border-forest/20 border-t-forest" />
              Restoring secure session…
            </div>
          </div>
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
      </main>

      {!isDashboard && (
        <footer className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-6 py-8 text-xs text-ink/50 sm:flex-row sm:items-center sm:justify-between lg:px-8">
          <p>Tenant boundaries are enforced by PostgreSQL Row-Level Security.</p>
          <p>React × Supabase × Stripe</p>
        </footer>
      )}
    </div>
  )
}
