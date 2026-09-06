package httpapi

import (
	"bufio"
	"bytes"
	"net/http"
	"net/url"
	"path"
	"strings"
	"testing"
)

func FuzzCanonicalRequestPath(f *testing.F) {
	for _, seed := range []string{
		"/", "/api/v1/workspace", "", "relative", "//double", "/a/../b", "/\\admin", "/a\x00b", "/a\nb",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, candidate string) {
		request := &http.Request{URL: &url.URL{Path: candidate}}
		if !canonicalRequestPath(request) {
			return
		}
		if candidate == "" || candidate[0] != '/' || path.Clean(candidate) != candidate ||
			strings.ContainsAny(candidate, "\\\x00\r\n") {
			t.Fatalf("accepted non-canonical request path %q", candidate)
		}
	})
}

func FuzzStartsWithJSONObject(f *testing.F) {
	for _, seed := range [][]byte{
		[]byte(`{}`), []byte(" \t\r\n{}"), []byte(`[]`), []byte(`null`), nil, []byte{0xff, '{'},
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, candidate []byte) {
		object, err := startsWithJSONObject(bufio.NewReader(bytes.NewReader(candidate)))
		if err != nil || !object {
			return
		}
		trimmed := bytes.TrimLeft(candidate, " \t\r\n")
		if len(trimmed) == 0 || trimmed[0] != '{' {
			t.Fatalf("classified non-object prefix as JSON object: %q", candidate)
		}
	})
}
