import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode
} from "react"

const classNames = (...values: ReadonlyArray<string | undefined>) =>
  values.filter((value): value is string => value !== undefined && value.length > 0).join(" ")

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "primary" | "secondary" | "ghost"
  readonly pending?: boolean
  readonly pendingLabel?: ReactNode
}

export const Button = ({
  variant = "secondary",
  pending = false,
  pendingLabel,
  className,
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) => (
  <button
    {...props}
    aria-busy={pending ? true : undefined}
    className={classNames("atape-button", `atape-button--${variant}`, className)}
    disabled={disabled === true || pending}
    type={type}
  >
    {pending && pendingLabel !== undefined ? pendingLabel : children}
  </button>
)

export type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  readonly name: string
  readonly size?: "small" | "medium"
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()

export const Avatar = ({ name, size = "medium", className, ...props }: AvatarProps) => (
  <span
    {...props}
    aria-hidden="true"
    className={classNames("atape-avatar", `atape-avatar--${size}`, className)}
  >
    {initials(name)}
  </span>
)

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  readonly tone?: "neutral" | "accent" | "success" | "warning" | "danger"
}

export const Badge = ({ tone = "neutral", className, ...props }: BadgeProps) => (
  <span {...props} className={classNames("atape-badge", `atape-badge--${tone}`, className)} />
)

export const Eyebrow = ({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
  <p {...props} className={classNames("atape-eyebrow", className)} />
)
