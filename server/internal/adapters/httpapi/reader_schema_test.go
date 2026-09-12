package httpapi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/conversation"
	"github.com/SingleMai/ATape/server/internal/projectsearch"
	"gopkg.in/yaml.v3"
)

// These exported values are written directly by the HTTP Adapter. Compare their
// complete JSON field contract, including optional nested fields, so a Go change
// cannot silently leave the reader's OpenAPI response as a generic object.
func TestOpenAPIReaderSchemasMatchWireTypes(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	encoded, err := os.ReadFile(filepath.Join(filepath.Dir(source), "../../../../docs/api/openapi-v1.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Paths map[string]struct {
			Get struct {
				Responses map[string]struct {
					Ref string `yaml:"$ref"`
				}
			}
		}
		Components struct {
			Schemas   map[string]readerSchema
			Responses map[string]struct {
				Content map[string]struct{ Schema readerSchema }
			}
		}
	}
	if err := yaml.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct {
		path, name string
		value      any
	}{
		{"/api/v1/projects/{projectId}/memory", "ProjectMemory", conversation.ProjectMemory{}},
		{"/api/v1/projects/{projectId}/search", "SearchPage", projectsearch.Page{}},
		{"/api/v1/sessions/{sessionId}", "Conversation", conversation.Conversation{}},
	} {
		t.Run(entry.name, func(t *testing.T) {
			if got := document.Paths[entry.path].Get.Responses["200"].Ref; got != "#/components/responses/"+entry.name {
				t.Fatalf("reader response reference = %q", got)
			}
			schema := document.Components.Responses[entry.name].Content["application/json"].Schema
			if schema.Ref != "#/components/schemas/"+entry.name {
				t.Fatalf("reader schema reference = %q", schema.Ref)
			}
			if err := compareReaderSchema(reflect.TypeOf(entry.value), schema, document.Components.Schemas, entry.name); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestReaderSchemaComparisonRejectsFieldDrift(t *testing.T) {
	closed := false
	typ := reflect.TypeOf(struct {
		Items []struct {
			Label string `json:"label,omitempty"`
		} `json:"items"`
	}{})
	for _, defect := range []string{"missing field", "wrong type", "wrong required", "open object"} {
		t.Run(defect, func(t *testing.T) {
			item := readerSchema{Type: "object", AdditionalProperties: &closed, Properties: map[string]readerSchema{"label": {Type: "string"}}}
			switch defect {
			case "missing field":
				delete(item.Properties, "label")
			case "wrong type":
				item.Properties["label"] = readerSchema{Type: "integer"}
			case "wrong required":
				item.Required = []string{"label"}
			case "open object":
				item.AdditionalProperties = nil
			}
			schema := readerSchema{Type: "object", AdditionalProperties: &closed, Required: []string{"items"}, Properties: map[string]readerSchema{"items": {Type: "array", Items: &item}}}
			if err := compareReaderSchema(typ, schema, nil, "response"); err == nil {
				t.Fatal("accepted a changed nested response contract")
			}
		})
	}
}

type readerSchema struct {
	Ref                  string                  `yaml:"$ref"`
	Type                 any                     `yaml:"type"`
	Required             []string                `yaml:"required"`
	Properties           map[string]readerSchema `yaml:"properties"`
	Items                *readerSchema           `yaml:"items"`
	AdditionalProperties *bool                   `yaml:"additionalProperties"`
}

// This compares wire shape, not arbitrary JSON Schema validation. Semantic
// constraints remain covered by the reader/ingestion/publication behavior tests.
func compareReaderSchema(typ reflect.Type, schema readerSchema, schemas map[string]readerSchema, path string) error {
	if schema.Ref != "" {
		name, ok := strings.CutPrefix(schema.Ref, "#/components/schemas/")
		resolved, found := schemas[name]
		if !ok || !found || resolved.Ref != "" {
			return fmt.Errorf("%s: missing or indirect schema %s", path, schema.Ref)
		}
		schema = resolved
	}
	if typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ == reflect.TypeOf(json.RawMessage{}) {
		if schema.Type != nil || len(schema.Properties) != 0 {
			return fmt.Errorf("%s: admitted RawMessage must preserve arbitrary JSON including null", path)
		}
		return nil
	}
	want := map[reflect.Kind]string{reflect.Struct: "object", reflect.Slice: "array", reflect.String: "string", reflect.Int: "integer"}[typ.Kind()]
	if want == "" || schema.Type != want {
		return fmt.Errorf("%s: schema type %q does not describe %s", path, schema.Type, typ)
	}
	if typ.Kind() == reflect.Slice {
		if schema.Items == nil {
			return fmt.Errorf("%s: array has no item schema", path)
		}
		return compareReaderSchema(typ.Elem(), *schema.Items, schemas, path+"[]")
	}
	if typ.Kind() != reflect.Struct {
		return nil
	}
	if schema.AdditionalProperties == nil || *schema.AdditionalProperties || len(schema.Properties) != typ.NumField() {
		return fmt.Errorf("%s: object must declare exactly the exported wire fields", path)
	}
	required := []string{}
	for n := 0; n < typ.NumField(); n++ {
		field := typ.Field(n)
		parts := strings.Split(field.Tag.Get("json"), ",")
		name := parts[0]
		property, ok := schema.Properties[name]
		if name == "" || !ok {
			return fmt.Errorf("%s: missing JSON property for %s", path, field.Name)
		}
		if !slices.Contains(parts[1:], "omitempty") {
			required = append(required, name)
		}
		if err := compareReaderSchema(field.Type, property, schemas, path+"."+name); err != nil {
			return err
		}
	}
	actual := slices.Clone(schema.Required)
	slices.Sort(actual)
	slices.Sort(required)
	if !slices.Equal(actual, required) {
		return fmt.Errorf("%s: required properties = %v, wire requires %v", path, actual, required)
	}
	return nil
}
