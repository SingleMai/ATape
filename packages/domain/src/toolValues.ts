// Shared admission rules for JSON tool values. No provider knowledge or I/O.
export const ToolValueBytes = 64 * 1024
export const ToolUpdateBytes = 140_000
export const isBoundedToolValue = (value: unknown): boolean => {
  let nodes = 0
  const visit = (input: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 32) return false
    if (input === null || typeof input === "boolean" || typeof input === "string") return true
    if (typeof input === "number") return Number.isFinite(input)
    if (Array.isArray(input)) {
      for (const item of input) if (!visit(item, depth + 1)) return false
      return true
    }
    if (typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return false
    return Object.values(input).every(item => visit(item, depth + 1))
  }
  try { return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= ToolValueBytes }
  catch { return false }
}
