import { homedir } from "node:os"
import { join } from "node:path"

export type NodeClientPaths = {
  readonly atapeHome: string
  readonly credentialDirectory: string
  readonly configFile: string
  readonly collectorStateFile: string
  readonly collectorProcessFile: string
  readonly collectorStatusFile: string
  readonly collectorLogFile: string
  readonly adapterDirectory: string
}

export const defaultNodeClientPaths = (environment: NodeJS.ProcessEnv = process.env): NodeClientPaths => {
  const atapeHome = environment.ATAPE_HOME || join(homedir(), ".atape")
  return {
    atapeHome,
    credentialDirectory: join(atapeHome, "credentials"),
    configFile: environment.ATAPE_CONFIG_FILE || join(atapeHome, "config", "client.json"),
    collectorStateFile: environment.ATAPE_COLLECTOR_STATE_FILE || join(atapeHome, "state", "collector.json"),
    collectorProcessFile: environment.ATAPE_COLLECTOR_PROCESS_FILE || join(atapeHome, "state", "collector-process.json"),
    collectorStatusFile: environment.ATAPE_COLLECTOR_STATUS_FILE || join(atapeHome, "state", "collector-status.json"),
    collectorLogFile: environment.ATAPE_COLLECTOR_LOG_FILE || join(atapeHome, "logs", "collector.log"),
    adapterDirectory: environment.ATAPE_ADAPTER_DIRECTORY || join(atapeHome, "adapters")
  }
}
