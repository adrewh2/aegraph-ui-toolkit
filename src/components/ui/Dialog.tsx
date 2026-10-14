import { X } from 'lucide-react'
import { useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useArmed } from './useArmed'
import { useDismiss } from './useDismiss'
import { useFocusTrap } from './useFocusTrap'
import './ui.css'

interface DialogProps {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** Extra class on the dialog box, for a page-specific width or layout. */
  className?: string
  /** The id of an element in the body that describes the dialog, when there is no `description` (a confirmation's message). */
  describedBy?: string
  /** A close button (×) in the top-right corner, for a dialog that is looked at more than answered. */
  closable?: boolean
}

/**
 * The app's modal dialog, announced by its title and its description (`aria-labelledby`, `aria-describedby`).
 */
export function Dialog({ open, title, description, onClose, children, footer, wide, className, describedBy, closable }: DialogProps) {
  const box = useRef<HTMLDivElement>(null)
  const id = useId()
  // A layer for Escape, which closes only the topmost thing — a dropdown open in the dialog first. A press outside is
  // the backdrop's own: only a press on this dialog's backdrop closes it, not one on a dialog opened over it.
  useDismiss(onClose, { active: open, inside: () => [box.current], outside: false })
  // Focus goes in when it opens (to what asked for it with autoFocus or data-autofocus, else the first field or
  // button), stays in while it is open (Tab wraps), and goes back to where it was when it closes — so a keyboard never
  // lands on the page behind a modal, and closing one does not drop focus on the body. The same trap as the command
  // palette's (`useFocusTrap`), which notes who had the focus while rendering: by the time an effect runs, an
  // autoFocus inside has already taken it.
  useFocusTrap(box, open)

  if (!open) return null
  return createPortal(
    // The press must start on the backdrop itself. The box does not stop presses from leaving it: a dropdown inside
    // listens for them to know when to close.
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className={`dialog ${wide ? 'dialog--wide' : ''} ${className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : describedBy}
        tabIndex={-1}
      >
        <h2 id={`${id}-title`} className="dialog__title">
          {title}
        </h2>
        {description && (
          <p id={`${id}-desc`} className="dialog__desc">
            {description}
          </p>
        )}
        <div className="dialog__body">{children}</div>
        {footer && <div className="dialog__footer">{footer}</div>}
        {/* Last in the markup, drawn in the corner: the focus starts on the dialog's first choice, not on its way out. */}
        {closable && (
          <button type="button" className="dialog__close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}

interface ConfirmProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  /**
   * A question someone other than the user asked — a tool, Claude Code over the bridge: Cancel has the focus whatever
   * the question, and yes cannot be pressed for a moment after it appears or its words change (`useArmed`). A question
   * that pops up under a keystroke or a click meant for something else must not be answered by it.
   */
  guarded?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, guarded = false, onConfirm, onCancel }: ConfirmProps) {
  const id = useId()
  const armed = useArmed(open, guarded, message)
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      describedBy={`${id}-message`}
      footer={
        <>
          {/* A dangerous one starts on Cancel: Enter on a dialog that just opened must not delete anything. So does one a tool asked. */}
          <button className="btn" onClick={onCancel} autoFocus={danger || guarded}>
            Cancel
          </button>
          <button className={`btn btn--primary ${danger ? 'btn--danger-solid' : ''}`} onClick={() => armed && onConfirm()} disabled={!armed} autoFocus={!danger && !guarded}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p id={`${id}-message`} style={{ margin: 0 }}>
        {message}
      </p>
    </Dialog>
  )
}
