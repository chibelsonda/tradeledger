export function CheckoutCanceled() {
  return (
    <section className="mx-auto flex min-h-[68vh] w-full max-w-2xl items-center justify-center px-6 py-12 lg:px-8">
      <div className="w-full border border-ink/10 bg-white p-8 text-center shadow-[0_24px_64px_rgba(19,37,31,0.11)] sm:p-12">
        <div className="mx-auto grid size-18 place-items-center border border-amber-200 bg-amber-50 text-amber-700">
          <svg viewBox="0 0 24 24" className="size-10" fill="none" aria-hidden="true">
            <path
              d="M8 8l8 8m0-8-8 8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="mt-7 flex flex-col gap-3">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-forest/80">
            No charge was made
          </p>
          <h1 className="text-3xl font-extrabold tracking-[-0.035em] text-ink sm:text-4xl">
            Checkout canceled
          </h1>
          <p className="mx-auto max-w-md text-sm leading-6 font-medium text-ink/85">
            Your order is still waiting whenever you are ready. Return to the
            product page to restart secure checkout.
          </p>
        </div>
        <a
          href="/"
          className="mt-8 inline-flex h-10 items-center justify-center bg-ink px-5 text-sm font-bold text-white transition hover:bg-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
        >
          Return to checkout
        </a>
      </div>
    </section>
  )
}
