package canonical_test

import (
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/testsupport/canonicalcontract"
)

func TestMemoryStoreContract(t *testing.T) {
	canonicalcontract.Run(t, func(*testing.T) canonicalcontract.Store {
		return canonical.NewMemoryStoreWithControlPlane(canonicalcontract.MemoryControlPlane())
	})
}
