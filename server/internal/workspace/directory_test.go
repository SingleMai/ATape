package workspace

import (
	"context"
	"testing"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
)

func directoryPrincipal() authentication.Principal {
	return authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.WebAuthentication}
}

func TestDirectoryUsesSharedActiveSessionWindow(t *testing.T) {
	directory := NewDirectory(canonical.NewDemoStore())
	directory.now = func() time.Time { return mustDirectoryTime(t, "2026-09-04T10:50:00+08:00") }

	recent, err := directory.Open(context.Background(), directoryPrincipal())
	if err != nil {
		t.Fatalf("open recent directory: %v", err)
	}
	project := findProject(recent, "payments-api")
	if project.ActiveSessionCount != 2 {
		t.Fatalf("recent active count = %d, want 2", project.ActiveSessionCount)
	}

	directory.now = func() time.Time { return mustDirectoryTime(t, "2026-09-04T11:00:00+08:00") }
	stale, err := directory.Open(context.Background(), directoryPrincipal())
	if err != nil {
		t.Fatalf("open stale directory: %v", err)
	}
	project = findProject(stale, "payments-api")
	if project.ActiveSessionCount != 0 {
		t.Fatalf("stale active count = %d, want 0", project.ActiveSessionCount)
	}
}

func findProject(workspace Workspace, id string) Project {
	for _, team := range workspace.Teams {
		for _, project := range team.Projects {
			if project.ID == id {
				return project
			}
		}
	}
	return Project{}
}

func mustDirectoryTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse test time: %v", err)
	}
	return parsed
}
