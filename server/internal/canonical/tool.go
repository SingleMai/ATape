package canonical

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ToolUpdate is the admitted ACP tool profile, scoped by its Event's Session and
// Thread. RawMessage distinguishes absent, null, false, zero and empty values.
type ToolUpdate struct {
	SessionUpdate string          `json:"sessionUpdate"`
	ToolCallID    string          `json:"toolCallId"`
	Title         *string         `json:"title,omitempty"`
	Kind          *string         `json:"kind,omitempty"`
	Status        *string         `json:"status,omitempty"`
	RawInput      json.RawMessage `json:"rawInput,omitempty"`
	RawOutput     json.RawMessage `json:"rawOutput,omitempty"`
}

var errTool = errors.New("invalid bounded ACP tool update")

// ParseToolUpdate validates a stored/wire update without reserializing its values.
// Callers retain the original JSON string for Canonical identity and persistence.
func ParseToolUpdate(text string) (*ToolUpdate, error) {
	if len(text) > 140000 || !utf8.ValidString(text) || !validToolJSON(text, 34, 21000) {
		return nil, errTool
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(text), &fields) != nil || fields == nil {
		return nil, errTool
	}
	for key := range fields {
		switch key {
		case "sessionUpdate", "toolCallId", "title", "kind", "status", "rawInput", "rawOutput":
		default:
			return nil, errTool
		}
	}
	var tool ToolUpdate
	if json.Unmarshal([]byte(text), &tool) != nil || strings.TrimSpace(tool.ToolCallID) == "" || len(tool.ToolCallID) > 500 {
		return nil, errTool
	}
	if tool.SessionUpdate != "tool_call" && tool.SessionUpdate != "tool_call_update" {
		return nil, errTool
	}
	if tool.SessionUpdate == "tool_call" && (tool.Title == nil || strings.TrimSpace(*tool.Title) == "") {
		return nil, errTool
	}
	if tool.Title != nil && len(*tool.Title) > 500 {
		return nil, errTool
	}
	if tool.Kind != nil && !stringIn(*tool.Kind, "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other") {
		return nil, errTool
	}
	if tool.Status != nil && !stringIn(*tool.Status, "pending", "in_progress", "completed", "failed") {
		return nil, errTool
	}
	for _, value := range []json.RawMessage{tool.RawInput, tool.RawOutput} {
		if value != nil && (len(value) > 65536 || !validToolJSON(string(value), 32, 10000)) {
			return nil, errTool
		}
	}
	return &tool, nil
}

// Summary is the common display/Search projection, not a second writable fact.
func (t *ToolUpdate) Summary() (kind, text, label string) {
	label = t.ToolCallID
	if t.Title != nil && *t.Title != "" {
		label = *t.Title
	}
	status := ""
	if t.Status != nil {
		status = *t.Status
	}
	kind = "tool_call"
	if t.SessionUpdate == "tool_call" {
		text = label
		if status != "" {
			text += " · " + status
		}
		return
	}
	if status == "" {
		status = "updated"
	}
	if status == "completed" || status == "failed" {
		kind = "tool_result"
	}
	text = label + " · " + status
	return
}

func stringIn(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}

func validToolJSON(text string, maxDepth, maxNodes int) bool {
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	nodes := 0
	var visit func(int) bool
	visit = func(depth int) bool {
		nodes++
		if depth > maxDepth || nodes > maxNodes {
			return false
		}
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		switch value := token.(type) {
		case json.Number:
			number, err := strconv.ParseFloat(string(value), 64)
			return err == nil && !math.IsInf(number, 0) && !math.IsNaN(number)
		case json.Delim:
			if value != '{' && value != '[' {
				return false
			}
			keys := map[string]bool{}
			for decoder.More() {
				if value == '{' {
					key, err := decoder.Token()
					name, ok := key.(string)
					if err != nil || !ok || keys[name] {
						return false
					}
					keys[name] = true
				}
				if !visit(depth + 1) {
					return false
				}
			}
			close, err := decoder.Token()
			return err == nil && (value == '{' && close == json.Delim('}') || value == '[' && close == json.Delim(']'))
		default:
			return true
		}
	}
	if !visit(0) {
		return false
	}
	_, err := decoder.Token()
	return err == io.EOF
}
