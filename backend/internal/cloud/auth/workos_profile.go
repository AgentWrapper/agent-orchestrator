package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	workOSAPIBaseURL      = "https://api.workos.com"
	workOSProfileCacheTTL = 5 * time.Minute
)

type cachedExternalProfile struct {
	profile ExternalProfile
	until   time.Time
}

// NewWorkOSProfileResolver returns a cached resolver for WorkOS user profiles.
func NewWorkOSProfileResolver(apiKey string, client *http.Client) (ExternalProfileResolver, error) {
	return newWorkOSProfileResolver(apiKey, workOSAPIBaseURL, client, workOSProfileCacheTTL)
}

func newWorkOSProfileResolver(
	apiKey string,
	baseURL string,
	client *http.Client,
	cacheTTL time.Duration,
) (ExternalProfileResolver, error) {
	apiKey = strings.TrimSpace(apiKey)
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if apiKey == "" || baseURL == "" {
		return nil, fmt.Errorf("WorkOS profile resolution requires an API key and base URL")
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	var mu sync.Mutex
	cache := make(map[string]cachedExternalProfile)
	return func(ctx context.Context, subject string) (ExternalProfile, error) {
		subject = strings.TrimSpace(subject)
		if subject == "" {
			return ExternalProfile{}, fmt.Errorf("WorkOS user ID is required")
		}
		now := time.Now()
		mu.Lock()
		cached, ok := cache[subject]
		mu.Unlock()
		if ok && now.Before(cached.until) {
			return cached.profile, nil
		}

		requestURL := baseURL + "/user_management/users/" + url.PathEscape(subject)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
		if err != nil {
			return ExternalProfile{}, fmt.Errorf("create WorkOS user request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		resp, err := client.Do(req)
		if err != nil {
			return ExternalProfile{}, fmt.Errorf("get WorkOS user: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return ExternalProfile{}, fmt.Errorf("get WorkOS user: unexpected status %d", resp.StatusCode)
		}
		var user struct {
			ID        string `json:"id"`
			Email     string `json:"email"`
			FirstName string `json:"first_name"`
			LastName  string `json:"last_name"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
			return ExternalProfile{}, fmt.Errorf("decode WorkOS user: %w", err)
		}
		if strings.TrimSpace(user.ID) != subject {
			return ExternalProfile{}, fmt.Errorf("WorkOS user response does not match token subject")
		}
		email := strings.ToLower(strings.TrimSpace(user.Email))
		displayName := strings.TrimSpace(strings.Join(
			nonEmptyStrings(user.FirstName, user.LastName),
			" ",
		))
		profile := ExternalProfile{
			Email:       email,
			DisplayName: firstNonEmpty(displayName, email),
		}
		if profile.Email == "" {
			return ExternalProfile{}, fmt.Errorf("WorkOS user response is missing email")
		}
		mu.Lock()
		cache[subject] = cachedExternalProfile{profile: profile, until: now.Add(cacheTTL)}
		mu.Unlock()
		return profile, nil
	}, nil
}

func nonEmptyStrings(values ...string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	return result
}
