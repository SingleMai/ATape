package architecture_test

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestFxRemainsInCompositionRoot(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	violations, err := fxImportsOutsideCompositionRoot(filepath.Dir(source))
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) != 0 {
		t.Fatalf("Fx imports outside the Composition Root: %v", violations)
	}
}

func fxImportsOutsideCompositionRoot(root string) ([]string, error) {
	var violations []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "vendor" || strings.HasPrefix(entry.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "cmd/") || strings.HasPrefix(rel, "internal/bootstrap/") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imported := range file.Imports {
			name, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if name == "go.uber.org/fx" || strings.HasPrefix(name, "go.uber.org/fx/") {
				violations = append(violations, rel)
			}
		}
		return nil
	})
	return violations, err
}

func TestFxBoundaryUsesGoImportsAcrossBuildTargets(t *testing.T) {
	root := t.TempDir()
	for path, source := range map[string]string{
		"cmd/server/main.go":       "package main\nimport _ \"go.uber.org/fx\"",
		"internal/bootstrap/fx.go": "package bootstrap\nimport fx \"go.uber.org/fx\"",
		"internal/safe/module.go":  "package safe\n// import \"go.uber.org/fx\"\nconst example = `import \"go.uber.org/fx\"`",
		"internal/bad/windows.go":  "//go:build windows\n\npackage bad\nimport alias \"go.uber.org/fx\"",
		"internal/bad/log.go":      "package bad\nimport (\n _ \"go.uber.org/fx/fxevent\"\n)",
	} {
		file := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(source), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	violations, err := fxImportsOutsideCompositionRoot(root)
	if err != nil || len(violations) != 2 {
		t.Fatalf("violations = %v, error = %v", violations, err)
	}
}
