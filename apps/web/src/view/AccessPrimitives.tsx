import { Avatar, Button } from "@atape/ui"
import { useEffect, useRef, type ReactNode } from "react"
import type { FailureView } from "../presenters/accessPresenter"

export const TapeMark = ({ className }: { readonly className?: string }) => (
  <svg aria-hidden="true" className={className} viewBox="0 0 48 38">
    <path d="M8 4h32l5 7v16l-5 7H8l-5-7V11z" fill="currentColor" />
    <circle cx="18" cy="19" r="6" fill="var(--atape-color-paper)" />
    <circle cx="30" cy="19" r="6" fill="var(--atape-color-paper)" />
    <circle cx="18" cy="19" r="2" fill="var(--atape-color-text-muted)" />
    <circle cx="30" cy="19" r="2" fill="var(--atape-color-text-muted)" />
  </svg>
)

export const AccessBrand = ({ home = "/" }: { readonly home?: string }) => (
  <a className="access-brand" href={home} aria-label="ATape home">
    <TapeMark className="access-brand-mark" />
    <span>ATape</span>
  </a>
)

export const AccountChip = ({ displayName }: { readonly displayName: string }) => (
  <div className="account-chip" aria-label={`Signed in as ${displayName}`}>
    <Avatar name={displayName} size="small" />
    <span>{displayName}</span>
  </div>
)

export const AccessHeader = ({ displayName }: { readonly displayName?: string }) => (
  <header className="access-header">
    <AccessBrand />
    {displayName !== undefined && <AccountChip displayName={displayName} />}
  </header>
)

export const FailureNotice = ({
  failure,
  onRetry,
  retryLabel = "Try again"
}: {
  readonly failure: FailureView
  readonly onRetry?: () => void
  readonly retryLabel?: string
}) => (
  <div className="access-notice access-notice--error" role="alert">
    <span>
      <strong>{failure.message}</strong>
      {failure.incident !== undefined && <small>Incident {failure.incident}</small>}
    </span>
    {failure.retryable && onRetry !== undefined && <Button onClick={onRetry}>{retryLabel}</Button>}
  </div>
)

export const SuccessNotice = ({ children }: { readonly children: ReactNode }) => (
  <div className="access-notice access-notice--success" role="status">{children}</div>
)

export type Confirmation = {
  readonly eyebrow?: string
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly danger?: boolean
}

export const ConfirmationDialog = ({
  confirmation,
  pending,
  onCancel,
  onConfirm
}: {
  readonly confirmation: Confirmation | undefined
  readonly pending: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}) => {
  const reference = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = reference.current
    if (dialog === null) return
    if (confirmation !== undefined && !dialog.open) dialog.showModal()
    if (confirmation === undefined && dialog.open) dialog.close()
  }, [confirmation])

  return (
    <dialog
      ref={reference}
      className="confirmation-dialog"
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-description"
      onCancel={(event) => {
        event.preventDefault()
        if (!pending) onCancel()
      }}
      onClose={() => {
        if (confirmation !== undefined && !pending) onCancel()
      }}
    >
      {confirmation !== undefined && (
        <>
          <div className="confirmation-body">
            <p className="atape-eyebrow">{confirmation.eyebrow ?? "Confirm action"}</p>
            <h2 id="confirmation-title">{confirmation.title}</h2>
            <p id="confirmation-description">{confirmation.description}</p>
          </div>
          <div className="confirmation-actions">
            <Button disabled={pending} onClick={onCancel}>Cancel</Button>
            <Button
              className={confirmation.danger === true ? "danger-button" : undefined}
              variant={confirmation.danger === true ? "secondary" : "primary"}
              pending={pending}
              pendingLabel="Working…"
              onClick={onConfirm}
            >
              {confirmation.confirmLabel}
            </Button>
          </div>
        </>
      )}
    </dialog>
  )
}

export const FullPageState = ({ children, role }: {
  readonly children: ReactNode
  readonly role?: "alert" | "status"
}) => (
  <div className="access-page">
    <main id="main-content" className="access-state-card" {...(role === undefined ? {} : { role })}>
      <AccessBrand />
      <p>{children}</p>
    </main>
  </div>
)
