import { Schema } from "effect"

export const Actor = Schema.Struct({
  name: Schema.String,
  harness: Schema.String
})
export type Actor = typeof Actor.Type

export const Project = Schema.Struct({
  id: Schema.String,
  teamId: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["git", "directory"])
})
export type Project = typeof Project.Type

export const SessionStatus = Schema.Literals(["active", "idle", "ended"])
export type SessionStatus = typeof SessionStatus.Type

export const CaptureStatus = Schema.Literals(["healthy", "complete", "partial", "degraded"])
export type CaptureStatus = typeof CaptureStatus.Type

export const SessionSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  insight: Schema.String,
  actor: Actor,
  branch: Schema.String,
  status: SessionStatus,
  updatedAt: Schema.String,
  eventCount: Schema.Number,
  childThreadCount: Schema.Number
})
export type SessionSummary = typeof SessionSummary.Type

export const ProjectMemory = Schema.Struct({
  project: Project,
  capturedThrough: Schema.String,
  active: Schema.Array(SessionSummary),
  trail: Schema.Array(SessionSummary)
})
export type ProjectMemory = typeof ProjectMemory.Type

export const Session = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  actor: Actor,
  branch: Schema.String,
  status: SessionStatus,
  captureStatus: CaptureStatus,
  updatedAt: Schema.String
})
export type Session = typeof Session.Type

export const Thread = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  parentThreadId: Schema.optionalKey(Schema.String),
  captureStatus: CaptureStatus
})
export type Thread = typeof Thread.Type

export const ThreadPathItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String
})
export type ThreadPathItem = typeof ThreadPathItem.Type

export const ChildThreadRef = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  summary: Schema.String,
  captureStatus: CaptureStatus,
  eventCount: Schema.Number
})
export type ChildThreadRef = typeof ChildThreadRef.Type

export const CanonicalEvent = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "message",
    "thought",
    "tool_call",
    "tool_result",
    "artifact",
    "spawn",
    "lifecycle",
    "context",
    "notice"
  ]),
  author: Schema.String,
  occurredAt: Schema.String,
  text: Schema.String,
  toolLabel: Schema.optionalKey(Schema.String),
  childThread: Schema.optionalKey(ChildThreadRef)
})
export type CanonicalEvent = typeof CanonicalEvent.Type

export const Conversation = Schema.Struct({
  session: Session,
  thread: Thread,
  threadPath: Schema.Array(ThreadPathItem),
  events: Schema.Array(CanonicalEvent)
})
export type Conversation = typeof Conversation.Type
