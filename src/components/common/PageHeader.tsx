import type { ReactNode } from 'react'

interface Props {
  title: string
  description?: ReactNode
  help?: ReactNode
  status?: ReactNode
  actions?: ReactNode
}

/** Shared page hierarchy; editor/canvas toolbars keep their independent height and interaction contract. */
export default function PageHeader({ title, description, help, status, actions }: Props) {
  return (
    <header className="mb-6" data-page-header>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold leading-snug text-content-primary break-words">{title}</h1>
            {help}
            {status}
          </div>
          {description && <p className="mt-2 max-w-3xl text-13 leading-relaxed text-content-secondary">{description}</p>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
