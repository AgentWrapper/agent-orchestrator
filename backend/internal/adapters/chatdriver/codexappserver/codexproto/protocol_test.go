package codexproto

import (
	"encoding/json"
	"testing"
)

// Types the generator aliases to json.RawMessage must stay aliases.
//
// A DEFINED type (`type RequestID json.RawMessage`) does not inherit
// json.RawMessage's UnmarshalJSON. encoding/json then treats it as a plain
// []byte and demands a base64 string, so every non-string value fails to
// decode. The failure is quiet wherever the caller ignores the error, and it
// cost us every `serverRequest/resolved` notification — approvals resolved by
// another client stopped being applied — because request ids arrive as numbers.
//
// An ALIAS (`type RequestID = json.RawMessage`) keeps the methods. 46 generated
// types are in this position, so this is a property of the generator worth
// pinning rather than a single field worth remembering.
func TestRawMessageAliasesDecodeEveryJSONKind(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"number", `{"requestId":4}`},
		{"string", `{"requestId":"req-4"}`},
		{"object", `{"requestId":{"nested":true}}`},
		{"null", `{"requestId":null}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got struct {
				RequestID RequestID `json:"requestId"`
			}
			if err := json.Unmarshal([]byte(tc.body), &got); err != nil {
				t.Fatalf("decode %s: %v\nRequestID must be an alias to json.RawMessage, "+
					"not a defined type over it", tc.body, err)
			}
		})
	}
}

// The generated surface has to actually describe methods, and the digest has to
// move when it changes. A silently empty table would make the conformance test
// vacuous — it would pass by having nothing to check.
func TestGeneratedSurfaceIsPopulated(t *testing.T) {
	if len(Methods) == 0 {
		t.Fatal("no methods generated")
	}
	if ProviderVersion == "" || ProviderVersion == "unknown" {
		t.Errorf("ProviderVersion = %q; the generated file cannot say which build it describes", ProviderVersion)
	}
	if len(ProtocolDigest) == 0 {
		t.Error("ProtocolDigest is empty")
	}

	// Every method carries a direction, and requests are the only ones that may
	// name a result.
	for _, m := range Methods {
		if m.Direction == "" {
			t.Errorf("%s has no direction", m.Name)
		}
		if m.Result != "" && m.Direction != "ClientRequest" && m.Direction != "ServerRequest" {
			t.Errorf("%s is a %s yet names result %q", m.Name, m.Direction, m.Result)
		}
	}

	if !Declares(MethodThreadStart) {
		t.Error("Declares() does not recognize thread/start")
	}
	if Declares("thread/definitelyNotAMethod") {
		t.Error("Declares() accepted a method that does not exist")
	}
}
