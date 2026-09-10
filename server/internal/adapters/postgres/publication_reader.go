package postgres

import (
	"context"
	"errors"

	"github.com/SingleMai/ATape/server/internal/adapters/postgres/internal/db"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/jackc/pgx/v5"
)

func readPublicationEvents(ctx context.Context, q *db.Queries, snapshot *canonical.ConversationSnapshot, threadID string, page canonical.ConversationPageRequest) error {
	id, err := publicationID(snapshot.Head)
	if err != nil {
		return err
	}
	params := db.ListPublicationThreadMembersParams{AttemptID: id, ThreadID: threadID, PageLimit: int32(page.Limit + 1)}
	if page.AfterEventID != "" {
		position, e := q.GetPublicationEventPosition(ctx, db.GetPublicationEventPositionParams{AttemptID: id, ThreadID: threadID, RecordID: page.AfterEventID})
		if errors.Is(e, pgx.ErrNoRows) {
			return publicationError("invalid", "page position is not in the selected Thread")
		}
		if e != nil {
			return persist("read page position", e)
		}
		params.HasAfter = true
		params.AfterOrder, params.AfterIndex, params.AfterID = position.SourceOrder, position.EventIndex, position.RecordID
	}
	rows, err := q.ListPublicationThreadMembers(ctx, params)
	if err != nil {
		return persist("read selected Event membership", err)
	}
	if len(rows) > page.Limit {
		rows = rows[:page.Limit]
		snapshot.NextEventID = rows[len(rows)-1].RecordID
	}
	var fixed canonical.WriteBatch
	var previous int32 = -1
	for _, row := range rows {
		if row.PartOrdinal != previous {
			fixed, err = fixedPublicationPart(ctx, q, id, row.PartOrdinal)
			if err != nil {
				return err
			}
			previous = row.PartOrdinal
		}
		if row.EntryIndex < 0 || int(row.EntryIndex) >= len(fixed.Events) || fixed.Events[row.EntryIndex].ID != row.RecordID {
			return persist("read selected Event", errors.New("member coordinate differs from fixed content"))
		}
		snapshot.Events = append(snapshot.Events, fixed.Events[row.EntryIndex])
	}
	return nil
}
