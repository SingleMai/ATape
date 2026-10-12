package canonical

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ToolUpdate is the admitted ACP tool profile, scoped by its Event's Session and
// Thread. RawMessage distinguishes absent, null, false, zero and empty values.
type ToolUpdate struct {
	SessionUpdate string            `json:"sessionUpdate"`
	ToolCallID    string            `json:"toolCallId"`
	Title         *string           `json:"title,omitempty"`
	Kind          *string           `json:"kind,omitempty"`
	Status        *string           `json:"status,omitempty"`
	RawInput      json.RawMessage   `json:"rawInput,omitempty"`
	RawOutput     json.RawMessage   `json:"rawOutput,omitempty"`
	Meta          *ToolIdentityMeta `json:"_meta,omitempty"`
}

const ToolIdentityNamespace = "atape.dev/tool-identity"
const FileActivityNamespace = "atape.dev/file-activity"
const MaxFileActivityEntries = 64
const MaxFileActivityBytes = 4096
const MaxFilePathBytes = 2048

// ToolIdentity is an Adapter-normalized identity, never inferred from labels or
// tool payloads. A nil identity in a present Meta explicitly clears the fact.
type ToolIdentity struct {
	Type   string `json:"type"`
	Server string `json:"server,omitempty"`
	Name   string `json:"name"`
}
type ToolIdentityMeta struct {
	Identity     *ToolIdentity   `json:"atape.dev/tool-identity"`
	FileActivity json.RawMessage `json:"atape.dev/file-activity,omitempty"`
}

// FileActivityEntry is an explicit Adapter fact. Search paths describe scope,
// not matching files. Paths retain their exact spelling and are never resolved.
type FileActivityEntry struct {
	Operation string `json:"operation"`
	Path      string `json:"path"`
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
		case "sessionUpdate", "toolCallId", "title", "kind", "status", "rawInput", "rawOutput", "_meta":
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
	if data, present := fields["_meta"]; present {
		var envelope map[string]json.RawMessage
		if json.Unmarshal(data, &envelope) != nil || envelope[ToolIdentityNamespace] == nil {
			return nil, errTool
		}
		for key := range envelope {
			if key != ToolIdentityNamespace && key != FileActivityNamespace {
				return nil, errTool
			}
		}
		if activity, present := envelope[FileActivityNamespace]; present {
			if !validFileActivity(activity) {
				return nil, errTool
			}
		}
		identity := envelope[ToolIdentityNamespace]
		if !bytes.Equal(bytes.TrimSpace(identity), []byte("null")) {
			var values map[string]json.RawMessage
			if json.Unmarshal(identity, &values) != nil || values == nil || tool.Meta == nil || tool.Meta.Identity == nil {
				return nil, errTool
			}
			value := tool.Meta.Identity
			if !identityText(value.Name) || !validIdentityUnicode(values["name"]) || value.Type == "mcp" && (!identityText(value.Server) || !validIdentityUnicode(values["server"]) || len(values) != 3) ||
				(value.Type == "skill" || value.Type == "tool") && len(values) != 2 || !stringIn(value.Type, "mcp", "skill", "tool") {
				return nil, errTool
			}
			for key := range values {
				if key != "type" && key != "name" && (key != "server" || value.Type != "mcp") {
					return nil, errTool
				}
			}
		}
	}
	for _, value := range []json.RawMessage{tool.RawInput, tool.RawOutput} {
		if value != nil && (len(value) > 65536 || !validToolJSON(string(value), 32, 10000)) {
			return nil, errTool
		}
	}
	return &tool, nil
}

func validFileActivity(data json.RawMessage) bool {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return true
	}
	var entries []map[string]json.RawMessage
	if json.Unmarshal(data, &entries) != nil || entries == nil || len(entries) > MaxFileActivityEntries {
		return false
	}
	encodedBytes := 2 // JSON.stringify's array brackets, independent of wire escapes.
	for index, fields := range entries {
		var entry FileActivityEntry
		encoded, _ := json.Marshal(fields)
		if len(fields) != 2 || fields["operation"] == nil || fields["path"] == nil || json.Unmarshal(encoded, &entry) != nil || !stringIn(entry.Operation, "read", "edit", "search") || !validIdentityUnicode(fields["path"]) || entry.Path == "" || len(entry.Path) > MaxFilePathBytes {
			return false
		}
		for _, char := range entry.Path {
			if unicode.IsControl(char) {
				return false
			}
			if char == '"' || char == '\\' {
				encodedBytes++
			}
		}
		encodedBytes += len(`{"operation":"","path":""}`) + len(entry.Operation) + len(entry.Path)
		if index != 0 {
			encodedBytes++
		}
	}
	return encodedBytes <= MaxFileActivityBytes
}

func identityText(value string) bool {
	// ECMAScript trims BOM while Go's Unicode space set also includes NEL.
	// Reject their union so the TS and Go admission contracts agree.
	return value != "" && strings.TrimSpace(value) == value && strings.Trim(value, "\ufeff") == value && len(value) <= 500 && utf8.ValidString(value)
}

// encoding/json replaces orphan UTF-16 surrogate escapes with U+FFFD. Identity
// must reject those escapes before that replacement can merge distinct names.
// This applies only to the new identity strings, not historical tool payloads.
func validIdentityUnicode(data json.RawMessage) bool {
	data = bytes.TrimSpace(data)
	if len(data) < 2 || data[0] != '"' || data[len(data)-1] != '"' {
		return false
	}
	end := len(data) - 1
	for at := 1; at < end; {
		if data[at] != '\\' {
			at++
			continue
		}
		if at+1 >= end {
			return false
		}
		if data[at+1] != 'u' {
			at += 2
			continue
		}
		if at+6 > end {
			return false
		}
		value, err := strconv.ParseUint(string(data[at+2:at+6]), 16, 16)
		if err != nil {
			return false
		}
		at += 6
		if value >= 0xDC00 && value <= 0xDFFF {
			return false
		}
		if value < 0xD800 || value > 0xDBFF {
			continue
		}
		if at+6 > end || data[at] != '\\' || data[at+1] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(data[at+2:at+6]), 16, 16)
		if err != nil || low < 0xDC00 || low > 0xDFFF {
			return false
		}
		at += 6
	}
	return true
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
