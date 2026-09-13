package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/canonical"
	"github.com/SingleMai/ATape/server/internal/teamoverview"
)

func TestOverviewSessionPageHTTPContract(t *testing.T) {
	handler := testHandler(t)
	handler.overview = teamoverview.New(canonical.NewDemoStore())
	read := func(path string, status int) map[string]any {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: status=%d, cache=%q, body=%s", path, response.Code, response.Header().Get("Cache-Control"), response.Body.String())
		}
		if status == http.StatusOK && !strings.Contains(response.Header().Get("Server-Timing"), "total;dur=") {
			t.Fatal("successful read omitted operation timing")
		}
		var value map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	const route = "/api/v1/teams/acme-engineering/overview"
	const query = "?from=2026-09-04&to=2026-09-04&page=0&limit=1"
	full := read(route+query, http.StatusOK)
	page := read(route+"/sessions"+query, http.StatusOK)
	for _, key := range []string{"trend", "members", "projects", "models"} {
		if _, exists := page[key]; exists {
			t.Fatalf("Session page includes dashboard-only %s", key)
		}
		delete(full, key)
	}
	if page["updatedAt"] == "" || page["updatedAt"] == nil {
		t.Fatal("missing snapshot timestamp")
	}
	delete(full, "updatedAt")
	delete(page, "updatedAt")
	if !reflect.DeepEqual(full, page) {
		t.Fatalf("Session page differs from visible overview fields: full=%+v page=%+v", full, page)
	}
	for _, suffix := range []string{"", "/sessions"} {
		compact := read(route+suffix+query+"&options=compact", http.StatusOK)
		legacy := read(route+suffix+query, http.StatusOK)
		for _, key := range []string{"members", "projects"} {
			choices := compact["options"].(map[string]any)[key].([]any)
			oldChoices := legacy["options"].(map[string]any)[key].([]any)
			if len(choices) == 0 || len(choices) != len(oldChoices) {
				t.Fatal("missing option directory")
			}
			for i, value := range choices {
				option := value.(map[string]any)
				old := oldChoices[i].(map[string]any)
				if len(option) != 3 || len(old) != 6 || old["tokens"] == nil || option["id"] != old["id"] || option["name"] != old["name"] || option["current"] != old["current"] {
					t.Fatalf("compact/legacy drift: %v %v", option, old)
				}
			}
		}
		delete(compact, "options")
		delete(legacy, "options")
		delete(compact, "updatedAt")
		delete(legacy, "updatedAt")
		if !reflect.DeepEqual(compact, legacy) {
			t.Fatal("compact representation changed statistics")
		}
		if _, ok := compact["Diagnostics"]; ok {
			t.Fatal("diagnostics leaked into JSON")
		}
	}
	read(route+"?options=unknown", http.StatusUnprocessableEntity)
	read(route+"/sessions?page=invalid", http.StatusUnprocessableEntity)
	read(route+"/sessions?limit=51", http.StatusUnprocessableEntity)
	read("/api/v1/teams/unknown-team/overview/sessions", http.StatusNotFound)
}
