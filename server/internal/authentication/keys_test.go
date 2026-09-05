package authentication_test

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/SingleMai/ATape/server/internal/authentication"
)

func TestKeyRingRejectsWeakMissingAndDuplicateKeys(t *testing.T) {
	t.Parallel()

	if _, err := authentication.NewKeyRing("active", []authentication.KeyMaterial{{
		ID: "active", Material: bytes.Repeat([]byte{1}, 31),
	}}); err == nil {
		t.Fatal("31-byte key was accepted")
	}
	if _, err := authentication.NewKeyRing("missing", []authentication.KeyMaterial{{
		ID: "other", Material: bytes.Repeat([]byte{1}, 32),
	}}); err == nil {
		t.Fatal("missing active key was accepted")
	}
	if _, err := authentication.NewKeyRing("active", []authentication.KeyMaterial{
		{ID: "active", Material: bytes.Repeat([]byte{1}, 32)},
		{ID: "active", Material: bytes.Repeat([]byte{2}, 32)},
	}); err == nil {
		t.Fatal("duplicate key id was accepted")
	}

	material := bytes.Repeat([]byte{3}, 32)
	ring, err := authentication.NewKeyRing("active", []authentication.KeyMaterial{{
		ID: "active", Material: material,
	}})
	if err != nil {
		t.Fatalf("create valid key ring: %v", err)
	}
	for index := range material {
		material[index] = 0
	}
	if rendered := fmt.Sprintf("%#v", ring); strings.Contains(rendered, "3 3 3") || !strings.Contains(rendered, "redacted") {
		t.Fatalf("key ring formatting was not redacted: %s", rendered)
	}
}
