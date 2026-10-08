import type { ReactNode } from 'react'

/**
 * The head of a framed page: title and one-line subtitle on the left,
 * the page's actions on the right. Every page that has a title uses it,
 * so titles sit at the same place and size everywhere.
 */
export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head__text">
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </div>
  )
}
