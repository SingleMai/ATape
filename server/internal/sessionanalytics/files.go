package sessionanalytics

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

const MaxFilePaths = 2000

// FileActivity describes explicit file facts on folded calls. Missing facts do
// not establish that no file was used. Search paths are scopes, not matches.
type FileActivity struct {
	CallsWithActivity    int        `json:"callsWithActivity"`
	CallsWithoutActivity int        `json:"callsWithoutActivity"`
	ReadCalls            int        `json:"readCalls"`
	EditCalls            int        `json:"editCalls"`
	SearchCalls          int        `json:"searchCalls"`
	UniquePaths          int        `json:"uniquePaths"`
	Paths                []FilePath `json:"paths"`
}

type FilePath struct {
	Key         string `json:"key"`
	Path        string `json:"path"`
	Calls       int    `json:"calls"`
	ReadCalls   int    `json:"readCalls"`
	EditCalls   int    `json:"editCalls"`
	SearchCalls int    `json:"searchCalls"`
}

func filePathKey(path string) string {
	encoded, _ := json.Marshal([]string{"file-path.v1", path})
	sum := sha256.Sum256(encoded)
	return "file:" + hex.EncodeToString(sum[:])
}

func deriveFileActivity(ctx context.Context, calls map[callKey]*toolCall, q Query, candidates map[string]EvidenceItem) (*FileActivity, error) {
	report := &FileActivity{Paths: []FilePath{}}
	paths := make(map[string]*FilePath)
	selectors := make(map[string]bool)
	for _, call := range calls {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(call.fileActivity) == 0 {
			report.CallsWithoutActivity++
			continue
		}
		report.CallsWithActivity++
		seen := make(map[[2]string]bool)
		seenPaths, operations := make(map[string]bool), make(map[string]bool)
		matches := false
		for _, entry := range call.fileActivity {
			pair := [2]string{entry.Operation, entry.Path}
			if seen[pair] {
				continue
			}
			seen[pair] = true
			group := paths[entry.Path]
			if group == nil {
				if len(paths) >= MaxFilePaths {
					return nil, ErrCapacity
				}
				group = &FilePath{Key: filePathKey(entry.Path), Path: entry.Path}
				paths[entry.Path] = group
				selectors[group.Key] = true
			}
			if !seenPaths[entry.Path] {
				group.Calls++
				seenPaths[entry.Path] = true
			}
			incrementFileOperation(entry.Operation, &group.ReadCalls, &group.EditCalls, &group.SearchCalls)
			operations[entry.Operation] = true
			if (q.File == "" || q.File == group.Key) && (q.Operation == "" || q.Operation == entry.Operation) {
				matches = true
			}
		}
		for operation := range operations {
			incrementFileOperation(operation, &report.ReadCalls, &report.EditCalls, &report.SearchCalls)
		}
		if q.Metric == "files" && matches {
			candidates[call.event.ID] = evidence(call.event, call.name)
		}
	}
	if q.File != "" && !selectors[q.File] {
		return nil, &InvalidQueryError{"file", "is outside this snapshot"}
	}
	for _, path := range paths {
		report.Paths = append(report.Paths, *path)
	}
	sort.Slice(report.Paths, func(i, j int) bool {
		a, b := report.Paths[i], report.Paths[j]
		if a.Calls != b.Calls {
			return a.Calls > b.Calls
		}
		return a.Path < b.Path
	})
	report.UniquePaths = len(report.Paths)
	return report, nil
}

func incrementFileOperation(operation string, read, edit, search *int) {
	switch operation {
	case "read":
		*read++
	case "edit":
		*edit++
	case "search":
		*search++
	}
}
