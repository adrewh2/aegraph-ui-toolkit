import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import './ui.css'

const ToastContext = createContext<(msg: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const toast = useCallback((m: string) => {
    setMsg(m)
    clearTimeout(timer.current)
    // Long enough to read a sentence; a screen reader hears it through the live region below.
    timer.current = setTimeout(() => setMsg(null), 4500)
  }, [])
  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Always in the page, so the live region is there before its text arrives — one that appears with its text is
          not announced by every screen reader. */}
      <div role="status" aria-live="polite" className="toast-live">
        {msg && <div className="toast">{msg}</div>}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
