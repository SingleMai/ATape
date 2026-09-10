package postgres

import (
	"context"
	"encoding/json"
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
	params := db.ListPublicationThreadMembersParams{AttemptID: id, ThreadID: threadID, PageLimit: int32(page.Limit + 1), IncludeAnchor: true}
	anchor := page.AfterEventID
	if page.AtEventID != "" {
		anchor = page.AtEventID
		params.IncludeAnchor = true
	}
	if anchor != "" {
		position, e := q.GetPublicationEventPosition(ctx, db.GetPublicationEventPositionParams{AttemptID: id, ThreadID: threadID, RecordID: anchor})
		if errors.Is(e, pgx.ErrNoRows) {
			return publicationError("invalid", "page position is not in the selected Thread")
		}
		if e != nil {
			return persist("read page position", e)
		}
		params.IncludeAnchor = page.AtEventID != ""
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

	// Group only bounded membership coordinates. A legal capture may interleave
	// source order across parts; decode each required part once, without retaining
	// a cache of whole decoded parts. The retained prefix can only shrink as more
	// event sizes become known, so future groups beyond it need no body read.
	groups := make(map[int32][]int)
	ordinals := make([]int32, 0)
	for index, row := range rows {
		if _, ok := groups[row.PartOrdinal]; !ok {
			ordinals = append(ordinals, row.PartOrdinal)
		}
		groups[row.PartOrdinal] = append(groups[row.PartOrdinal], index)
	}
	selected := make([]canonical.EventRecord, len(rows))
	sizes := make([]int, len(rows))
	end, retained := len(rows), 0
	for _, ordinal := range ordinals {
		indices := groups[ordinal]
		if indices[0] >= end {
			continue
		}
		fixed, e := fixedPublicationPart(ctx, q, id, ordinal)
		if e != nil {
			return e
		}
		for _, index := range indices {
			if index >= end {
				break
			}
			row := rows[index]
			if row.EntryIndex < 0 || int(row.EntryIndex) >= len(fixed.Events) || fixed.Events[row.EntryIndex].ID != row.RecordID {
				return persist("read selected Event", errors.New("member coordinate differs from fixed content"))
			}
			event := fixed.Events[row.EntryIndex]
			encoded, e := json.Marshal(event)
			if e != nil {
				return persist("measure selected Event", e)
			}
			selected[index], sizes[index] = event, len(encoded)
			retained += sizes[index]
			// Remove the furthest known events until the prefix fits. Keep the first
			// admitted Event even if it alone exceeds the soft budget.
			for last := end - 1; last > 0 && retained > 6<<20; last-- {
				if sizes[last] == 0 {
					continue
				}
				retained -= sizes[last]
				sizes[last] = 0
				selected[last] = canonical.EventRecord{}
				end = last
			}
		}
	}
	if end < len(rows) {
		snapshot.NextEventID = rows[end-1].RecordID
	}
	snapshot.Events = selected[:end]
	return nil
}
