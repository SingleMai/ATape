package authentication

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"

	"golang.org/x/crypto/hkdf"
)

const (
	digestVersion       = "sha256-v1"
	privateStateVersion = "private-state-v1"
	keySize             = 32
)

var keyIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

type KeyMaterial struct {
	ID       string
	Material []byte
}

// KeyRing keeps key bytes unexported after construction so diagnostics cannot
// accidentally serialize them. Copies returned by callers are not retained.
type KeyRing struct {
	activeID string
	keys     map[string][keySize]byte
}

func (r KeyRing) String() string   { return "authentication.KeyRing{redacted}" }
func (r KeyRing) GoString() string { return r.String() }

func NewKeyRing(activeID string, entries []KeyMaterial) (KeyRing, error) {
	if !keyIDPattern.MatchString(activeID) {
		return KeyRing{}, errors.New("active authentication key id is invalid")
	}
	ring := KeyRing{activeID: activeID, keys: make(map[string][keySize]byte, len(entries))}
	for _, entry := range entries {
		if !keyIDPattern.MatchString(entry.ID) {
			return KeyRing{}, errors.New("authentication key id is invalid")
		}
		if len(entry.Material) != keySize {
			return KeyRing{}, fmt.Errorf("authentication key %q must decode to 32 bytes", entry.ID)
		}
		if _, duplicate := ring.keys[entry.ID]; duplicate {
			return KeyRing{}, fmt.Errorf("authentication key id %q is duplicated", entry.ID)
		}
		var material [keySize]byte
		copy(material[:], entry.Material)
		ring.keys[entry.ID] = material
	}
	if _, ok := ring.keys[activeID]; !ok {
		return KeyRing{}, errors.New("active authentication key is missing")
	}
	return ring, nil
}

func DecodeKeyMaterial(id, encoded string) (KeyMaterial, error) {
	decoded, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		decoded, err = base64.StdEncoding.DecodeString(encoded)
	}
	if err != nil || len(decoded) != keySize {
		return KeyMaterial{}, fmt.Errorf("authentication key %q must be base64-encoded 32-byte material", id)
	}
	return KeyMaterial{ID: id, Material: decoded}, nil
}

func (r KeyRing) active() (string, [keySize]byte, error) {
	key, ok := r.keys[r.activeID]
	if !ok {
		return "", [keySize]byte{}, errors.New("active authentication key is unavailable")
	}
	return r.activeID, key, nil
}

func (r KeyRing) get(id string) ([keySize]byte, bool) {
	key, ok := r.keys[id]
	return key, ok
}

func (r KeyRing) ids() []string {
	ids := make([]string, 0, len(r.keys))
	for id := range r.keys {
		ids = append(ids, id)
	}
	return ids
}

// ActiveShortCodeDigest returns a purpose-separated HMAC for a normalized
// low-entropy code without exposing the root pepper to another Module.
func (r KeyRing) ActiveShortCodeDigest(purpose, normalized string) (string, [sha256.Size]byte, error) {
	id, root, err := r.active()
	if err != nil {
		return "", [sha256.Size]byte{}, err
	}
	digest, err := keyedCodeDigest(root, purpose, normalized)
	return id, digest, err
}

// ShortCodeDigest verifies a normalized low-entropy code against one accepted
// pepper generation without exposing the root pepper.
func (r KeyRing) ShortCodeDigest(id, purpose, normalized string) ([sha256.Size]byte, bool, error) {
	root, ok := r.get(id)
	if !ok {
		return [sha256.Size]byte{}, false, nil
	}
	digest, err := keyedCodeDigest(root, purpose, normalized)
	return digest, true, err
}

// KeyIDs returns accepted key generations in stable order. It contains no key
// material and is safe for bounded verification loops.
func (r KeyRing) KeyIDs() []string {
	ids := r.ids()
	sort.Strings(ids)
	return ids
}

func deriveKey(root [keySize]byte, purpose string) ([keySize]byte, error) {
	reader := hkdf.New(sha256.New, root[:], []byte("atape/authentication/v1"), []byte(purpose))
	var derived [keySize]byte
	if _, err := io.ReadFull(reader, derived[:]); err != nil {
		return [keySize]byte{}, err
	}
	return derived, nil
}

func highEntropyDigest(kind, secret string) [sha256.Size]byte {
	hash := sha256.New()
	_, _ = hash.Write([]byte("atape/" + kind + "/v1\x00"))
	_, _ = hash.Write([]byte(secret))
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return digest
}

func keyedCodeDigest(root [keySize]byte, purpose, normalized string) ([sha256.Size]byte, error) {
	key, err := deriveKey(root, "hmac/"+purpose)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	mac := hmac.New(sha256.New, key[:])
	_, _ = mac.Write([]byte("atape/" + purpose + "/v1\x00"))
	_, _ = mac.Write([]byte(normalized))
	var digest [sha256.Size]byte
	copy(digest[:], mac.Sum(nil))
	return digest, nil
}

func newAEAD(root [keySize]byte) (cipher.AEAD, error) {
	key, err := deriveKey(root, "aead/private-state")
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
