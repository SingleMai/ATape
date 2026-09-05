package conversation

import (
	"context"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
)

// SnapshotStore is the persistence Seam consumed by the conversation Module.
// Ordinary reads expose only active Canonical snapshots and never join Raw or
// historical projection records.
type SnapshotStore interface {
	Project(context.Context, authentication.Principal, string) (canonical.ProjectSnapshot, bool, error)
	Conversation(context.Context, authentication.Principal, string, string) (canonical.ConversationSnapshot, bool, error)
}
