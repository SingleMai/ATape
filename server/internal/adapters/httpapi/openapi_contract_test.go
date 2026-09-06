package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/authorization"
	"gopkg.in/yaml.v3"
)

type openAPIRouteExtension struct {
	Class                  string `yaml:"class"`
	RequestBodyPolicy      string `yaml:"requestBodyPolicy"`
	RequestBodyLimit       int64  `yaml:"requestBodyLimit"`
	CachePolicy            string `yaml:"cachePolicy"`
	OriginPolicy           string `yaml:"originPolicy"`
	FreshAuthentication    bool   `yaml:"freshAuthentication"`
	RequiresIdempotencyKey bool   `yaml:"requiresIdempotencyKey"`
}

type openAPIOperation struct {
	OperationID          string                    `yaml:"operationId"`
	Route                openAPIRouteExtension     `yaml:"x-atape-route"`
	AuthorizationActions *[]string                 `yaml:"x-atape-authorization-actions"`
	Security             []map[string][]string     `yaml:"security"`
	RequestBody          map[string]any            `yaml:"requestBody"`
	Responses            map[string]map[string]any `yaml:"responses"`
}

type openAPIPathItem struct {
	Get    *openAPIOperation `yaml:"get"`
	Post   *openAPIOperation `yaml:"post"`
	Put    *openAPIOperation `yaml:"put"`
	Patch  *openAPIOperation `yaml:"patch"`
	Delete *openAPIOperation `yaml:"delete"`
}

func (item openAPIPathItem) operations() map[string]*openAPIOperation {
	return map[string]*openAPIOperation{
		http.MethodGet: item.Get, http.MethodPost: item.Post, http.MethodPut: item.Put,
		http.MethodPatch: item.Patch, http.MethodDelete: item.Delete,
	}
}

type openAPIDocument struct {
	OpenAPI    string                     `yaml:"openapi"`
	Actions    []string                   `yaml:"x-atape-authorization-actions"`
	Paths      map[string]openAPIPathItem `yaml:"paths"`
	Components struct {
		Schemas struct {
			Problem struct {
				Properties struct {
					Code struct {
						Enum []string `yaml:"enum"`
					} `yaml:"code"`
				} `yaml:"properties"`
			} `yaml:"Problem"`
		} `yaml:"schemas"`
	} `yaml:"components"`
}

func TestOpenAPIMatchesExecutableRouteInventory(t *testing.T) {
	document := readOpenAPI(t)
	if document.OpenAPI != "3.1.0" {
		t.Fatalf("OpenAPI version = %q, want 3.1.0", document.OpenAPI)
	}
	expected := make(map[string]RouteContract)
	for _, registered := range testHandler(t).RouteInventory() {
		expected[registered.Method+" "+registered.Pattern] = registered
	}

	seenOperations := make(map[string]string)
	knownActions := make(map[string]struct{}, len(authorization.ActionInventory()))
	for _, action := range authorization.ActionInventory() {
		knownActions[action] = struct{}{}
	}
	coveredActions := make(map[string]struct{}, len(knownActions))
	for path, item := range document.Paths {
		for method, operation := range item.operations() {
			if operation == nil {
				continue
			}
			key := method + " " + path
			contract, ok := expected[key]
			if !ok {
				t.Fatalf("OpenAPI declares unregistered route %s", key)
			}
			delete(expected, key)
			if prior, duplicate := seenOperations[operation.OperationID]; operation.OperationID == "" || duplicate {
				t.Fatalf("route %s has missing or duplicate operationId %q (first at %s)", key, operation.OperationID, prior)
			}
			seenOperations[operation.OperationID] = key
			want := openAPIRouteExtension{
				Class: string(contract.Class), RequestBodyPolicy: contract.RequestBodyPolicy,
				RequestBodyLimit: contract.RequestBodyLimit, CachePolicy: contract.CachePolicy,
				OriginPolicy: contract.OriginPolicy, FreshAuthentication: contract.FreshAuthentication,
				RequiresIdempotencyKey: contract.RequiresIdempotencyKey,
			}
			if operation.Route != want {
				t.Fatalf("route metadata for %s = %+v, want %+v", key, operation.Route, want)
			}
			if contract.RequestBodyLimit == 0 && operation.RequestBody != nil {
				t.Fatalf("bodyless route %s declares a request body", key)
			}
			if contract.RequestBodyLimit > 0 && operation.RequestBody == nil {
				t.Fatalf("JSON route %s omits its request body", key)
			}
			if len(operation.Responses) < 2 || operation.Responses["default"] == nil {
				t.Fatalf("route %s must document success and the shared Problem response", key)
			}
			if operation.AuthorizationActions == nil {
				t.Fatalf("route %s must explicitly declare its authorization actions", key)
			}
			if strings.Join(*operation.AuthorizationActions, "\n") != strings.Join(contract.AuthorizationActions, "\n") {
				t.Fatalf("route %s authorization actions = %v, registry declares %v", key,
					*operation.AuthorizationActions, contract.AuthorizationActions)
			}
			seenRouteActions := make(map[string]struct{}, len(*operation.AuthorizationActions))
			for _, action := range *operation.AuthorizationActions {
				if _, known := knownActions[action]; !known {
					t.Fatalf("route %s declares unknown authorization action %q", key, action)
				}
				if _, duplicate := seenRouteActions[action]; duplicate {
					t.Fatalf("route %s repeats authorization action %q", key, action)
				}
				seenRouteActions[action] = struct{}{}
				coveredActions[action] = struct{}{}
			}
			if contract.Class == PublicProtocol && len(*operation.AuthorizationActions) != 0 {
				t.Fatalf("public route %s declares resource authorization actions", key)
			}
			assertOpenAPISecurity(t, key, contract.Class, operation.Security)
		}
	}
	if len(expected) != 0 {
		missing := make([]string, 0, len(expected))
		for key := range expected {
			missing = append(missing, key)
		}
		sort.Strings(missing)
		t.Fatalf("OpenAPI is missing executable routes: %s", strings.Join(missing, ", "))
	}
	if len(coveredActions) != len(knownActions) {
		missing := make([]string, 0, len(knownActions)-len(coveredActions))
		for action := range knownActions {
			if _, covered := coveredActions[action]; !covered {
				missing = append(missing, action)
			}
		}
		sort.Strings(missing)
		t.Fatalf("OpenAPI routes do not reference every closed authorization action: %s", strings.Join(missing, ", "))
	}
}

func TestOpenAPIProblemCodesMatchTheRuntimeRegistry(t *testing.T) {
	documented := readOpenAPI(t).Components.Schemas.Problem.Properties.Code.Enum
	sort.Strings(documented)
	runtimeCodes := make([]string, 0, len(problemRegistry))
	for code := range problemRegistry {
		runtimeCodes = append(runtimeCodes, string(code))
	}
	sort.Strings(runtimeCodes)
	if strings.Join(documented, "\n") != strings.Join(runtimeCodes, "\n") {
		t.Fatalf("OpenAPI Problem codes = %v, runtime registry = %v", documented, runtimeCodes)
	}
}

func TestOpenAPIAuthorizationActionsMatchTheClosedPolicyCatalog(t *testing.T) {
	documented := readOpenAPI(t).Actions
	runtimeActions := authorization.ActionInventory()
	if strings.Join(documented, "\n") != strings.Join(runtimeActions, "\n") {
		t.Fatalf("OpenAPI actions = %v, runtime catalog = %v", documented, runtimeActions)
	}
}

func assertOpenAPISecurity(t *testing.T, key string, class RouteClass, security []map[string][]string) {
	t.Helper()
	names := make([]string, 0, len(security))
	for _, alternative := range security {
		if len(alternative) != 1 {
			t.Fatalf("route %s has a compound credential alternative: %+v", key, alternative)
		}
		for name := range alternative {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	want := ""
	switch class {
	case PublicProtocol:
	case WebOnly:
		want = "webSession"
	case CLIOnly:
		want = "cliCredential"
	case AnyPrincipal:
		want = "cliCredential\nwebSession"
	}
	if strings.Join(names, "\n") != want {
		t.Fatalf("security alternatives for %s = %v, want %q", key, names, want)
	}
}

func readOpenAPI(t *testing.T) openAPIDocument {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve OpenAPI contract test source")
	}
	path := filepath.Join(filepath.Dir(source), "..", "..", "..", "..", "docs", "api", "openapi-v1.yaml")
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read OpenAPI document: %v", err)
	}
	var document openAPIDocument
	if err := yaml.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("parse OpenAPI document: %v", err)
	}
	return document
}
