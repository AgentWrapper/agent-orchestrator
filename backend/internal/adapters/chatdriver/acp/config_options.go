package acp

import (
	"context"
	"errors"
	"fmt"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ListConfigOptions returns the live catalog the ACP agent last advertised.
// A copy leaves the conversation as the only writer while HTTP reads race with
// provider notifications and model-dependent catalog rebuilds.
func (c *conversation) ListConfigOptions(ctx context.Context) ([]ports.ChatConfigOption, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errConversationClosed
	}
	return cloneConfigOptions(c.configOptions), nil
}

// SetConfigOption applies exactly the type the provider advertised and replaces
// the whole catalog from the response. A model switch can change the effort and
// fast-mode options, so updating only the selected row would immediately make the
// rest of the UI stale.
func (c *conversation) SetConfigOption(
	ctx context.Context,
	id string,
	value ports.ChatConfigOptionValue,
) ([]ports.ChatConfigOption, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	sessionID := c.sessionID
	closed := c.closed
	var option *ports.ChatConfigOption
	for i := range c.configOptions {
		if c.configOptions[i].ID == id {
			snapshot := c.configOptions[i]
			option = &snapshot
			break
		}
	}
	c.mu.Unlock()

	if closed {
		return nil, errConversationClosed
	}
	if sessionID == "" {
		return nil, errors.New("ACP session is not open")
	}
	if option == nil {
		return nil, fmt.Errorf("%w: unknown ACP session config option %q", ports.ErrChatConfigOptionInvalid, id)
	}

	request := acpsdk.SetSessionConfigOptionRequest{}
	switch option.Type {
	case ports.ChatConfigOptionSelect:
		if value.Boolean != nil {
			return nil, fmt.Errorf("%w: ACP session config option %q requires a select value", ports.ErrChatConfigOptionInvalid, id)
		}
		if !choiceOffered(option.Choices, value.Select) {
			return nil, fmt.Errorf("%w: ACP session config option %q does not offer value %q", ports.ErrChatConfigOptionInvalid, id, value.Select)
		}
		request.ValueId = &acpsdk.SetSessionConfigOptionValueId{
			SessionId: acpsdk.SessionId(sessionID),
			ConfigId:  acpsdk.SessionConfigId(id),
			Value:     acpsdk.SessionConfigValueId(value.Select),
		}
	case ports.ChatConfigOptionBoolean:
		if value.Boolean == nil {
			return nil, fmt.Errorf("%w: ACP session config option %q requires a boolean value", ports.ErrChatConfigOptionInvalid, id)
		}
		request.Boolean = &acpsdk.SetSessionConfigOptionBoolean{
			SessionId: acpsdk.SessionId(sessionID),
			ConfigId:  acpsdk.SessionConfigId(id),
			Value:     *value.Boolean,
		}
	default:
		return nil, fmt.Errorf("%w: ACP session config option %q has unsupported type %q", ports.ErrChatConfigOptionInvalid, id, option.Type)
	}

	resp, err := c.conn.SetSessionConfigOption(ctx, request)
	if err != nil {
		return nil, fmt.Errorf("set ACP session config option %q: %w", id, err)
	}
	c.replaceConfigOptions(resp.ConfigOptions)
	return c.ListConfigOptions(ctx)
}

func (c *conversation) replaceConfigOptions(options []acpsdk.SessionConfigOption) {
	normalized := normalizeConfigOptions(options)
	c.mu.Lock()
	c.configOptions = normalized
	if len(normalized) > 0 {
		c.capabilities[ports.ChatCapabilityConfigOptions] = true
	}
	c.mu.Unlock()
}

func normalizeConfigOptions(options []acpsdk.SessionConfigOption) []ports.ChatConfigOption {
	out := make([]ports.ChatConfigOption, 0, len(options))
	for _, option := range options {
		switch {
		case option.Select != nil:
			selectOption := option.Select
			out = append(out, ports.ChatConfigOption{
				ID:          string(selectOption.Id),
				Name:        selectOption.Name,
				Description: stringValue(selectOption.Description),
				Category:    configCategory(selectOption.Category),
				Type:        ports.ChatConfigOptionSelect,
				Current: ports.ChatConfigOptionValue{
					Select: string(selectOption.CurrentValue),
				},
				Choices: normalizeSelectChoices(selectOption.Options),
			})
		case option.Boolean != nil:
			booleanOption := option.Boolean
			current := booleanOption.CurrentValue
			out = append(out, ports.ChatConfigOption{
				ID:          string(booleanOption.Id),
				Name:        booleanOption.Name,
				Description: stringValue(booleanOption.Description),
				Category:    configCategory(booleanOption.Category),
				Type:        ports.ChatConfigOptionBoolean,
				Current: ports.ChatConfigOptionValue{
					Boolean: &current,
				},
			})
		}
	}
	return out
}

func normalizeSelectChoices(options acpsdk.SessionConfigSelectOptions) []ports.ChatConfigOptionChoice {
	if options.Ungrouped != nil {
		out := make([]ports.ChatConfigOptionChoice, 0, len(*options.Ungrouped))
		for _, option := range *options.Ungrouped {
			out = append(out, normalizeChoice(option, "", ""))
		}
		return out
	}
	if options.Grouped == nil {
		return nil
	}
	count := 0
	for _, group := range *options.Grouped {
		count += len(group.Options)
	}
	out := make([]ports.ChatConfigOptionChoice, 0, count)
	for _, group := range *options.Grouped {
		for _, option := range group.Options {
			out = append(out, normalizeChoice(option, string(group.Group), group.Name))
		}
	}
	return out
}

func normalizeChoice(option acpsdk.SessionConfigSelectOption, group, groupName string) ports.ChatConfigOptionChoice {
	return ports.ChatConfigOptionChoice{
		Value:       string(option.Value),
		Name:        option.Name,
		Description: stringValue(option.Description),
		Group:       group,
		GroupName:   groupName,
	}
}

func configCategory(category *acpsdk.SessionConfigOptionCategory) string {
	if category == nil {
		return ""
	}
	return string(*category)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func choiceOffered(choices []ports.ChatConfigOptionChoice, value string) bool {
	for _, choice := range choices {
		if choice.Value == value {
			return true
		}
	}
	return false
}

func cloneConfigOptions(options []ports.ChatConfigOption) []ports.ChatConfigOption {
	out := make([]ports.ChatConfigOption, len(options))
	for i, option := range options {
		out[i] = option
		out[i].Choices = append([]ports.ChatConfigOptionChoice(nil), option.Choices...)
		if option.Current.Boolean != nil {
			current := *option.Current.Boolean
			out[i].Current.Boolean = &current
		}
	}
	return out
}
