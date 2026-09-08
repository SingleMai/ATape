export const stableVersion = (value: string) => /^\d+\.\d+\.\d+$/.test(value) && value.length < 40 &&
  value.split(".").every(part => Number.isSafeInteger(Number(part)))

export const newer = (candidate: string, current: string) => {
  if (!stableVersion(candidate) || !stableVersion(current)) return false
  const left = candidate.split(".").map(Number), right = current.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!
  return false
}
