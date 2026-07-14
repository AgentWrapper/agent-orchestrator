// Package push delivers dashboard notifications to registered phones as OS push
// notifications via the Expo Push Service (exp.host), which relays to APNs/FCM.
// The daemon is the sender: a dispatcher subscribes to the in-process notification
// hub and POSTs each new notification to every registered device.
package push

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// expoSendURL is the Expo Push Service send endpoint.
const expoSendURL = "https://exp.host/--/api/v2/push/send"

// Message is one Expo push message targeting a single device token.
type Message struct {
	To        string         `json:"to"`
	Title     string         `json:"title"`
	Body      string         `json:"body"`
	Data      map[string]any `json:"data,omitempty"`
	Sound     string         `json:"sound,omitempty"`
	Priority  string         `json:"priority,omitempty"`
	ChannelID string         `json:"channelId,omitempty"`
}

// Ticket is Expo's synchronous per-message result. Status is "ok" or "error";
// on error, Details.Error carries a code such as "DeviceNotRegistered".
type Ticket struct {
	Status  string `json:"status"`
	ID      string `json:"id,omitempty"`
	Message string `json:"message,omitempty"`
	Details struct {
		Error string `json:"error,omitempty"`
	} `json:"details,omitempty"`
}

// IsDeviceNotRegistered reports whether the ticket says the target token is dead
// (uninstalled or rotated) and should be pruned from the registry.
func (t Ticket) IsDeviceNotRegistered() bool {
	return t.Status == "error" && t.Details.Error == "DeviceNotRegistered"
}

// ExpoClient sends messages to the Expo Push Service. The zero value is not
// usable; construct it with NewExpoClient.
type ExpoClient struct {
	http        *http.Client
	url         string
	accessToken string // optional; enables Expo enforced push security when set
}

// NewExpoClient constructs a client. accessToken is optional (empty sends
// unauthenticated, which the Expo Push Service accepts by default).
func NewExpoClient(accessToken string) *ExpoClient {
	return &ExpoClient{
		http:        &http.Client{Timeout: 15 * time.Second},
		url:         expoSendURL,
		accessToken: accessToken,
	}
}

// maxBatch is the Expo Push Service per-request message cap.
const maxBatch = 100

// Send delivers messages to Expo and returns one ticket per message, in the same
// order. It chunks into batches of 100 (Expo's cap). A batch transport/HTTP error
// aborts and is returned; partial tickets from earlier batches are still returned.
func (c *ExpoClient) Send(ctx context.Context, messages []Message) ([]Ticket, error) {
	tickets := make([]Ticket, 0, len(messages))
	for start := 0; start < len(messages); start += maxBatch {
		end := start + maxBatch
		if end > len(messages) {
			end = len(messages)
		}
		batch, err := c.sendBatch(ctx, messages[start:end])
		if err != nil {
			return tickets, err
		}
		tickets = append(tickets, batch...)
	}
	return tickets, nil
}

func (c *ExpoClient) sendBatch(ctx context.Context, batch []Message) ([]Ticket, error) {
	body, err := json.Marshal(batch)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.accessToken)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("expo push: unexpected status %d", res.StatusCode)
	}
	var envelope struct {
		Data []Ticket `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("expo push: decode response: %w", err)
	}
	return envelope.Data, nil
}
