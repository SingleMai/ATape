import { useState } from "react"
import { resolveAgentIdentity } from "./agentIdentity"

export type AgentIdentityProps = {
  readonly provider: string
  readonly size?: 24 | 32
  readonly iconOnly?: boolean
  readonly className?: string
}

export const AgentIdentity = ({ provider, size = 24, iconOnly = false, className }: AgentIdentityProps) => {
  const { label, iconSrc } = resolveAgentIdentity(provider)
  const [failedSource, setFailedSource] = useState<string>()
  const showImage = iconSrc !== undefined && iconSrc !== failedSource
  return (
    <span className={["atape-agent-identity", className].filter(Boolean).join(" ")} title={iconOnly && showImage ? label : undefined}>
      {showImage && <img src={iconSrc} width={size} height={size} alt={iconOnly ? label : ""}
        onError={() => setFailedSource(iconSrc)} />}
      {(!iconOnly || !showImage) && <span>{label || "—"}</span>}
    </span>
  )
}
