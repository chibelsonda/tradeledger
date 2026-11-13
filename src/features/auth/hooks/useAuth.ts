import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'

import { supabase } from '../../../lib/supabase'

interface AuthState {
  isReady: boolean
  session: Session | null
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    isReady: false,
    session: null,
  })

  useEffect(() => {
    let isMounted = true

    void supabase.auth.getSession().then(({ data }) => {
      if (isMounted) {
        setState({ isReady: true, session: data.session })
      }
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ isReady: true, session })
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  return state
}
