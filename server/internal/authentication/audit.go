package authentication

import (
	"context"
	"encoding/json"
	"errors"

	authdb "github.com/SingleMai/ATape/server/internal/authentication/internal/db"
	"github.com/jackc/pgx/v5/pgtype"
)

type auditRecord struct {
	initiatorKind          string
	initiatorID            string
	action                 string
	targetKind             string
	targetID               string
	outcome                string
	reason                 string
	requestID              string
	providerRegistrationID string
	webSessionID           string
	cliCredentialID        string
	metadata               map[string]string
}

func appendAudit(ctx context.Context, queries *authdb.Queries, record auditRecord) error {
	id, err := newID()
	if err != nil {
		return err
	}
	webSessionID, err := optionalDatabaseUUID(record.webSessionID)
	if err != nil {
		return errors.New("invalid internal Web Session audit identity")
	}
	cliCredentialID, err := optionalDatabaseUUID(record.cliCredentialID)
	if err != nil {
		return errors.New("invalid internal CLI Credential audit identity")
	}
	encodedMetadata := []byte("{}")
	if len(record.metadata) > 0 {
		encodedMetadata, err = json.Marshal(record.metadata)
		if err != nil || len(encodedMetadata) > 2048 {
			return errors.New("invalid bounded security audit metadata")
		}
	}
	if len(record.initiatorID) > 200 || len(record.targetID) > 200 ||
		len(record.requestID) > 200 || len(record.providerRegistrationID) > 100 {
		return errors.New("security audit identity exceeds its bound")
	}
	return queries.InsertSecurityAuditEvent(ctx, authdb.InsertSecurityAuditEventParams{
		ID: mustDatabaseUUID(id), InitiatorKind: record.initiatorKind,
		InitiatorID: record.initiatorID, Action: record.action,
		TargetKind: record.targetKind, TargetID: record.targetID,
		Outcome: record.outcome, Reason: record.reason, RequestID: record.requestID,
		ProviderRegistrationID: record.providerRegistrationID,
		WebSessionID:           webSessionID, CliCredentialID: cliCredentialID,
		Metadata: encodedMetadata,
	})
}

func mustDatabaseUUID(value string) (result pgtype.UUID) {
	parsed, err := databaseUUID(value)
	if err != nil {
		panic("authentication generated an invalid UUID")
	}
	return parsed
}
