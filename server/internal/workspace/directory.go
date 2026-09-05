// Package workspace exposes the visible Team and Project directory as one
// consistently ordered, read-only Module.
package workspace

import (
	"context"
	"sort"
	"time"

	"github.com/SingleMai/ATape/server/internal/canonical"
)

type DirectoryStore interface {
	Workspace(context.Context, time.Time) (canonical.WorkspaceSnapshot, error)
}

type Project struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Type               string `json:"type"`
	CapturedThrough    string `json:"capturedThrough,omitempty"`
	SessionCount       int    `json:"sessionCount"`
	ActiveSessionCount int    `json:"activeSessionCount"`
}

type Team struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Projects []Project `json:"projects"`
}

type Workspace struct {
	Teams []Team `json:"teams"`
}

type Directory struct {
	store DirectoryStore
	now   func() time.Time
}

func NewDirectory(store DirectoryStore) *Directory {
	return &Directory{store: store, now: time.Now}
}

func (d *Directory) Open(ctx context.Context) (Workspace, error) {
	snapshot, err := d.store.Workspace(ctx, canonical.ActiveSessionCutoff(d.now()))
	if err != nil {
		return Workspace{}, err
	}
	sort.Slice(snapshot.Teams, func(left, right int) bool {
		if snapshot.Teams[left].Name != snapshot.Teams[right].Name {
			return snapshot.Teams[left].Name < snapshot.Teams[right].Name
		}
		return snapshot.Teams[left].ID < snapshot.Teams[right].ID
	})
	sort.Slice(snapshot.Projects, func(left, right int) bool {
		if snapshot.Projects[left].Project.TeamID != snapshot.Projects[right].Project.TeamID {
			return snapshot.Projects[left].Project.TeamID < snapshot.Projects[right].Project.TeamID
		}
		if snapshot.Projects[left].Project.Name != snapshot.Projects[right].Project.Name {
			return snapshot.Projects[left].Project.Name < snapshot.Projects[right].Project.Name
		}
		return snapshot.Projects[left].Project.ID < snapshot.Projects[right].Project.ID
	})

	projectsByTeam := make(map[string][]Project, len(snapshot.Teams))
	for _, stored := range snapshot.Projects {
		project := Project{
			ID: stored.Project.ID, Name: stored.Project.Name, Type: stored.Project.Type,
			SessionCount: stored.SessionCount, ActiveSessionCount: stored.ActiveSessionCount,
		}
		if !stored.CapturedThrough.IsZero() {
			project.CapturedThrough = stored.CapturedThrough.UTC().Format(time.RFC3339Nano)
		}
		projectsByTeam[stored.Project.TeamID] = append(projectsByTeam[stored.Project.TeamID], project)
	}
	result := Workspace{Teams: make([]Team, 0, len(snapshot.Teams))}
	for _, stored := range snapshot.Teams {
		projects := projectsByTeam[stored.ID]
		if projects == nil {
			projects = []Project{}
		}
		result.Teams = append(result.Teams, Team{ID: stored.ID, Name: stored.Name, Projects: projects})
	}
	return result, nil
}
