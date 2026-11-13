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

      {session && (
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
      )}
    </header>
  )
}
