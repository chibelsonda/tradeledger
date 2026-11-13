import { Button } from '@headlessui/react'
import type { Session } from '@supabase/supabase-js'
import { useState } from 'react'

import { supabase } from '../../lib/supabase'
import { Brand } from './Brand'

interface HeaderProps {
  session: Session | null
}

export function Header({ session }: HeaderProps) {
  const [isSigningOut, setIsSigningOut] = useState(false)

  async function signOut() {
    setIsSigningOut(true)
    await supabase.auth.signOut()
    setIsSigningOut(false)
  }

  return (
    <header className="mx-auto flex h-20 w-full max-w-7xl items-center justify-between gap-4 px-6 lg:px-8">
      <Brand />

      {session ? (
        <div className="flex items-center gap-2">
          <span className="hidden max-w-56 truncate text-xs font-semibold text-ink/85 sm:block">
            {session.user.email}
          </span>
          <Button
            type="button"
            onClick={() => void signOut()}
            disabled={isSigningOut}
            className="inline-flex h-9 items-center justify-center border border-ink/12 bg-white/80 px-4 text-xs font-bold text-ink shadow-[0_6px_18px_rgba(19,37,31,0.06)] backdrop-blur transition hover:border-forest/30 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest/50 disabled:cursor-wait disabled:opacity-60"
          >
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      ) : (
        <div className="inline-flex h-9 items-center gap-2 border border-ink/10 bg-white/75 px-3 text-xs font-semibold text-ink/80 shadow-[0_6px_18px_rgba(19,37,31,0.05)] backdrop-blur">
          <svg viewBox="0 0 20 20" className="size-4 text-forest" aria-hidden="true">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M10 1.75a4.25 4.25 0 0 0-4.25 4.25v1.25A2.75 2.75 0 0 0 3 10v5.5a2.75 2.75 0 0 0 2.75 2.75h8.5A2.75 2.75 0 0 0 17 15.5V10a2.75 2.75 0 0 0-2.75-2.75V6A4.25 4.25 0 0 0 10 1.75Zm2.75 5.5V6a2.75 2.75 0 1 0-5.5 0v1.25h5.5Z"
              clipRule="evenodd"
            />
          </svg>
          Supabase secured
        </div>
      )}
    </header>
  )
}
