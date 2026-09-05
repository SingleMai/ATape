package team

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/SingleMai/ATape/server/internal/authentication"
	teamdb "github.com/SingleMai/ATape/server/internal/team/internal/db"
	"github.com/jackc/pgx/v5/pgtype"
)

type auditRecord struct {
	principal  authentication.Principal
	action     string
	targetKind string
	targetID   string
	reason     string
	requestID  string
	metadata   map[string]string
}

func appendAudit(ctx context.Context, queries *teamdb.Queries, record auditRecord) error {
	id, err := newID()
	if err != nil {
		return err
	}
	webSessionID, err := optionalDatabaseUUID(record.principal.WebSessionID)
	if err != nil {
		return errors.New("invalid internal Web Session audit identity")
	}
	cliCredentialID, err := optionalDatabaseUUID(record.principal.CLICredentialID)
	if err != nil {
		return errors.New("invalid internal CLI Credential audit identity")
	}
	metadata := []byte("{}")
	if len(record.metadata) > 0 {
		metadata, err = json.Marshal(record.metadata)
		if err != nil || len(metadata) > 2048 {
			return errors.New("invalid bounded security audit metadata")
		}
	}
	if len(record.principal.UserID) > 200 || len(record.targetID) > 200 ||
		len(record.requestID) > 200 {
		return errors.New("security audit identity exceeds its bound")
	}
	return queries.InsertSecurityAuditEvent(ctx, teamdb.InsertSecurityAuditEventParams{
		ID: idToDatabase(id), InitiatorKind: "principal",
		InitiatorID: record.principal.UserID, Action: record.action,
		TargetKind: record.targetKind, TargetID: record.targetID,
		Outcome: "succeeded", Reason: record.reason, RequestID: record.requestID,
		WebSessionID: webSessionID, CliCredentialID: cliCredentialID,
		Metadata: metadata,
	})
}

func optionalDatabaseUUID(value string) (pgtype.UUID, error) {
	if value == "" {
		return pgtype.UUID{}, nil
	}
	return databaseUUID(value)
}

func idToDatabase(value string) pgtype.UUID {
	converted, err := databaseUUID(value)
	if err != nil {
		panic("Team Module generated an invalid UUID")
	}
	return converted
}
