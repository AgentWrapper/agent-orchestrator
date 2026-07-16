package scmconnection

import (
	"bytes"
	"encoding/json"
	"errors"
)

// TokenInput preserves whether the write-only token field was omitted.
type TokenInput struct {
	Value   string `json:"-"`
	Present bool   `json:"-"`
}

// UnmarshalJSON accepts only a string. In particular, explicit null is invalid.
func (t *TokenInput) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("token must be a string")
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	t.Value = value
	t.Present = true
	return nil
}
