import { CanonicalIngestionProtocolVersion, CanonicalProfileVersion, type CanonicalBatch, type AcpContentBlock, type AcpSessionUpdate } from "@atape/domain"
import type { CanonicalSubmission } from "./collector.ts"

/** Conservative size contract for publication-target.v1 materialization. Go JSON
 * additionally escapes HTML and U+2028/2029. Source scope is copied into every
 * normalized record; fixed headroom covers derived IDs, hashes, field names and
 * maximum-width receive provenance. A cross-language normalization test guards
 * this bound when the server's transport-neutral record layout changes. */
export const canonicalMaterializationBound = (batch: CanonicalBatch, userId: string): number => {
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength
  const goJSONBytes = (value: unknown) => bytes(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`))
  const scope = [batch.projectId, userId, batch.source.installationId, batch.source.adapterId, batch.session.sourceSessionId]
    .map(value => `${bytes(value)}:${value}`).join("")
  const records = batch.threads.length + batch.events.length + (batch.usage?.length ?? 0)
  return goJSONBytes(batch) + 4096 + (records + 2) * goJSONBytes(scope) + records * 2048
}

export const projectCanonicalSubmission = (submission: CanonicalSubmission): Omit<CanonicalBatch, "batchId"> => {
  const source = {
    adapterId: submission.adapterId,
    adapterVersion: submission.adapterVersion,
    installationId: submission.installationId
  }
  const events = submission.observation.events.map((event) => {
    const projection = projectAcpUpdate(event.update, submission.observation.session.actor)
    return {
      sourceEventId: event.sourceEventId,
      sourceThreadId: event.sourceThreadId,
      revision: event.revision,
      projectionRevision: event.projectionRevision,
      sourceOrder: event.sourceOrder,
      eventIndex: event.eventIndex,
      orderFidelity: event.orderFidelity,
      fidelity: event.fidelity,
      rawRef: event.rawRef._tag === "object"
        ? {
            type: "object" as const,
            sourceObjectId: event.rawRef.sourceObjectId,
            ...(event.rawRef.fragment === undefined ? {} : { fragment: event.rawRef.fragment })
          }
        : { type: "unavailable" as const, reason: event.rawRef.reason },
      kind: event.childSourceThreadId === undefined ? projection.kind : "spawn" as const,
      author: projection.author,
      occurredAt: event.occurredAt,
      text: projection.text,
      ...(projection.toolLabel === undefined ? {} : { toolLabel: projection.toolLabel }),
      ...("toolCallId" in event.update ? { toolUpdateJson: JSON.stringify(event.update) } : {}),
      ...(event.childSourceThreadId === undefined ? {} : { childSourceThreadId: event.childSourceThreadId })
    }
  })
  const base = {
    protocolVersion: CanonicalIngestionProtocolVersion,
    canonicalProfileVersion: CanonicalProfileVersion,
    observedAt: submission.observation.observedAt,
    source,
    projectId: submission.projectId,
    session: submission.observation.session,
    threads: submission.observation.threads,
    events,
    ...(submission.observation.usage === undefined ? {} : { usage: submission.observation.usage })
  }
  return base
}

const projectAcpUpdate = (
  update: AcpSessionUpdate,
  actor: { readonly name: string; readonly harness: string }
): { readonly kind: "message" | "thought" | "tool_call" | "tool_result"; readonly author: string; readonly text: string; readonly toolLabel?: string } => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return { kind: "message", author: actor.name, text: projectAcpContent(update.content) }
    case "agent_message_chunk":
      return { kind: "message", author: actor.harness, text: projectAcpContent(update.content) }
    case "agent_thought_chunk":
      return { kind: "thought", author: actor.harness, text: projectAcpContent(update.content) }
    case "tool_call":
      return {
        kind: "tool_call",
        author: actor.harness,
        text: update.status ? `${update.title} · ${update.status}` : update.title,
        toolLabel: update.title
      }
    case "tool_call_update": {
      const label = update.title || update.toolCallId
      const status = update.status || "updated"
      return {
        kind: status === "completed" || status === "failed" ? "tool_result" : "tool_call",
        author: actor.harness,
        text: `${label} · ${status}`,
        toolLabel: label
      }
    }
  }
}

const projectAcpContent = (content: AcpContentBlock): string => {
  switch (content.type) {
    case "text":
      return content.text
    case "image":
      return `[Image: ${content.mimeType}]`
    case "audio":
      return `[Audio: ${content.mimeType}]`
    case "resource_link":
      return `${content.title || content.name} · ${content.uri}`
    case "resource":
      return "text" in content.resource ? content.resource.text : `[Resource: ${content.resource.uri}]`
  }
}
