package authentication

import "io"

// setRandomSourceForContractTest is linked only into tests. The production
// Interface always uses crypto/rand; deterministic bytes let the contract suite
// prove bounded collision handling without weakening that Interface.
func SetRandomSourceForContractTest(module *Module, source io.Reader) {
	module.random = source
}

func MaintenanceLockIDForContractTest() int64 {
	return maintenanceLockID
}
