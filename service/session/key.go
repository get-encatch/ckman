package session

import (
	"crypto/rand"
	"encoding/base64"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/repository"
	"github.com/pkg/errors"
)

// The key that signs login tokens. Upstream ckman signed them with a fixed,
// public key; each installation now gets a random one on first start, kept
// encrypted in the database and shared by all its ckman instances.

const keyKind, keyID = "settings", "jwt-signing-key"

// LoadSigningKey reads the installation's key, creating it the first time.
func LoadSigningKey() error {
	if key, err := readKey(); err == nil {
		common.SetSigningKey(key)
		return nil
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return errors.Wrap(err, "generate token signing key")
	}
	enc := common.AesEncryptECB(base64.StdEncoding.EncodeToString(b))
	if err := repository.Ps.PutFleetObject(keyKind, keyID, keyID, []byte(enc)); err != nil {
		return errors.Wrap(err, "store token signing key")
	}
	// read back: if instances started together, all use the stored one
	key, err := readKey()
	if err != nil {
		return err
	}
	common.SetSigningKey(key)
	return nil
}

func readKey() ([]byte, error) {
	enc, err := repository.Ps.GetFleetObject(keyKind, keyID)
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.DecodeString(common.AesDecryptECB(string(enc)))
	if err != nil || len(key) < 32 {
		return nil, errors.New("stored token signing key is unreadable")
	}
	return key, nil
}
