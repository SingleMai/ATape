// Package ingestion exposes Canonical batch application as one deep Module.
package ingestion

import "fmt"

const ProtocolVersion = "atape.canonical.v1"
const CanonicalProfileVersion = "atape.acp-centered.v1"

type Source struct {
	AdapterID      string `json:"adapterId"`
	AdapterVersion string `json:"adapterVersion"`
	InstallationID string `json:"installationId"`
}

type RawReference struct {
	Type              string `json:"type"`
	SourceObjectID    string `json:"sourceObjectId,omitempty"`
	Fragment          string `json:"fragment,omitempty"`
	UnavailableReason string `json:"reason,omitempty"`
}

type Actor struct {
	Name    string `json:"name"`
	Harness string `json:"harness"`
}

type Session struct {
	SourceSessionID    string `json:"sourceSessionId"`
	Revision           int64  `json:"revision"`
	Title              string `json:"title"`
	Summary            string `json:"summary"`
	Insight            string `json:"insight"`
	Actor              Actor  `json:"actor"`
	Branch             string `json:"branch"`
	Status             string `json:"status"`
	CaptureStatus      string `json:"captureStatus"`
	UpdatedAt          string `json:"updatedAt"`
	ReportedEventCount int    `json:"reportedEventCount"`
}

type Thread struct {
	SourceThreadID       string  `json:"sourceThreadId"`
	ParentSourceThreadID *string `json:"parentSourceThreadId,omitempty"`
	Revision             int64   `json:"revision"`
	Label                string  `json:"label"`
	Summary              string  `json:"summary"`
	CaptureStatus        string  `json:"captureStatus"`
}

type Event struct {
	SourceEventID       string       `json:"sourceEventId"`
	SourceThreadID      string       `json:"sourceThreadId"`
	Revision            int64        `json:"revision"`
	ProjectionRevision  int64        `json:"projectionRevision"`
	SourceOrder         int64        `json:"sourceOrder"`
	EventIndex          int          `json:"eventIndex"`
	OrderFidelity       string       `json:"orderFidelity"`
	Fidelity            string       `json:"fidelity"`
	RawRef              RawReference `json:"rawRef"`
	Kind                string       `json:"kind"`
	Author              string       `json:"author"`
	OccurredAt          string       `json:"occurredAt"`
	Text                string       `json:"text"`
	ToolLabel           string       `json:"toolLabel,omitempty"`
	ChildSourceThreadID *string      `json:"childSourceThreadId,omitempty"`
}

type Batch struct {
	ProtocolVersion         string   `json:"protocolVersion"`
	CanonicalProfileVersion string   `json:"canonicalProfileVersion"`
	BatchID                 string   `json:"batchId"`
	ObservedAt              string   `json:"observedAt"`
	Source                  Source   `json:"source"`
	ProjectID               string   `json:"projectId"`
	Session                 Session  `json:"session"`
	Threads                 []Thread `json:"threads"`
	Events                  []Event  `json:"events"`
}

type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}
