package controllers

import (
	"encoding/base64"
	"testing"
)

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func TestDecodeSpawnAttachments(t *testing.T) {
	t.Run("nil when empty", func(t *testing.T) {
		out, err := decodeSpawnAttachments(nil)
		if err != nil || out != nil {
			t.Fatalf("want nil,nil got %v,%v", out, err)
		}
	})

	t.Run("decodes and maps extension", func(t *testing.T) {
		out, err := decodeSpawnAttachments([]SpawnAttachmentInput{
			{MimeType: "image/png", Data: b64([]byte("pngbytes"))},
			{MimeType: "IMAGE/JPEG", Data: b64([]byte("jpgbytes"))},
		})
		if err != nil {
			t.Fatalf("unexpected error: %+v", err)
		}
		if len(out) != 2 {
			t.Fatalf("want 2 attachments got %d", len(out))
		}
		if out[0].Ext != ".png" || string(out[0].Data) != "pngbytes" {
			t.Errorf("attachment 0 = %q %q", out[0].Ext, out[0].Data)
		}
		if out[1].Ext != ".jpg" {
			t.Errorf("case-insensitive mime not mapped: %q", out[1].Ext)
		}
	})

	t.Run("rejects too many", func(t *testing.T) {
		in := make([]SpawnAttachmentInput, maxAttachments+1)
		for i := range in {
			in[i] = SpawnAttachmentInput{MimeType: "image/png", Data: b64([]byte("x"))}
		}
		_, err := decodeSpawnAttachments(in)
		if err == nil || err.code != "TOO_MANY_ATTACHMENTS" {
			t.Fatalf("want TOO_MANY_ATTACHMENTS got %v", err)
		}
	})

	t.Run("rejects unsupported type", func(t *testing.T) {
		_, err := decodeSpawnAttachments([]SpawnAttachmentInput{{MimeType: "application/pdf", Data: b64([]byte("x"))}})
		if err == nil || err.code != "UNSUPPORTED_ATTACHMENT_TYPE" {
			t.Fatalf("want UNSUPPORTED_ATTACHMENT_TYPE got %v", err)
		}
	})

	// SVG is XML that can carry active content; the raster-only allowlist rejects it.
	t.Run("rejects svg", func(t *testing.T) {
		_, err := decodeSpawnAttachments([]SpawnAttachmentInput{{MimeType: "image/svg+xml", Data: b64([]byte("<svg/>"))}})
		if err == nil || err.code != "UNSUPPORTED_ATTACHMENT_TYPE" {
			t.Fatalf("want UNSUPPORTED_ATTACHMENT_TYPE got %v", err)
		}
	})

	t.Run("rejects invalid base64", func(t *testing.T) {
		_, err := decodeSpawnAttachments([]SpawnAttachmentInput{{MimeType: "image/png", Data: "!!!not base64!!!"}})
		if err == nil || err.code != "INVALID_ATTACHMENT_DATA" {
			t.Fatalf("want INVALID_ATTACHMENT_DATA got %v", err)
		}
	})

	t.Run("rejects empty payload", func(t *testing.T) {
		_, err := decodeSpawnAttachments([]SpawnAttachmentInput{{MimeType: "image/png", Data: ""}})
		if err == nil || err.code != "INVALID_ATTACHMENT_DATA" {
			t.Fatalf("want INVALID_ATTACHMENT_DATA got %v", err)
		}
	})

	t.Run("rejects oversized single attachment", func(t *testing.T) {
		big := b64(make([]byte, maxAttachmentBytes+1))
		_, err := decodeSpawnAttachments([]SpawnAttachmentInput{{MimeType: "image/png", Data: big}})
		if err == nil || err.code != "ATTACHMENT_TOO_LARGE" {
			t.Fatalf("want ATTACHMENT_TOO_LARGE got %v", err)
		}
	})

	t.Run("rejects oversized total", func(t *testing.T) {
		half := b64(make([]byte, maxAttachmentBytes))
		in := []SpawnAttachmentInput{
			{MimeType: "image/png", Data: half},
			{MimeType: "image/png", Data: half},
			{MimeType: "image/png", Data: half},
		}
		_, err := decodeSpawnAttachments(in)
		if err == nil || err.code != "ATTACHMENTS_TOO_LARGE" {
			t.Fatalf("want ATTACHMENTS_TOO_LARGE got %v", err)
		}
	})
}

func TestDecodeSpawnAttachmentsTrimsWhitespace(t *testing.T) {
	out, err := decodeSpawnAttachments([]SpawnAttachmentInput{
		{MimeType: "  image/png  ", Data: "  " + b64([]byte("hi")) + "  "},
	})
	if err != nil {
		t.Fatalf("unexpected error: %+v", err)
	}
	if len(out) != 1 || string(out[0].Data) != "hi" {
		t.Fatalf("whitespace not trimmed: %+v", out)
	}
}
