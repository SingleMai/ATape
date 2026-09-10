import type { SourceCollectionLimits } from "@atape/application"

export const sourceCollectionLimits: SourceCollectionLimits = {
  source: { rowBytes: 65536, pageBytes: 262144, pageRows: 2, records: 1000, threads: 20, durationMs: 10000 },
  projection: { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 },
  journal: { unitBytes: 4 * 1024 * 1024, targetBytes: 16 * 1024 * 1024, pendingBytes: 64 * 1024 * 1024, metadataEntries: 100_000, unitsPerTarget: 4096, recordsPerTarget: 4096 },
  raw: { objectBytes: 4000, wireBytes: 8192, targetBytes: 100000, units: 100 },
  comparison: { records: 4096, durationMs: 10000 }, recovery: { sources: 2, captures: 2, operations: 64, reclaimUnits: 32, sourceMs: 1000 }, sourceWorkMs: 10000, cycleMs: 30000
}
