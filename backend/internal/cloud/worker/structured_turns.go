package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const maxStructuredPrompt = 64 << 10

type structuredTurnRunner func(context.Context, string, string, int64) (string, error)

type structuredPrompt struct {
	text     string
	sequence int64
}

type queuedPromptWriter struct {
	ctx        context.Context
	prompts    chan<- structuredPrompt
	controller *structuredTurnController
}

func (w *queuedPromptWriter) Prompt(prompt string, sequence int64) error {
	if prompt == "" || len(prompt) > maxStructuredPrompt {
		return errors.New("structured prompt is empty or too large")
	}
	select {
	case <-w.ctx.Done():
		return w.ctx.Err()
	case w.prompts <- structuredPrompt{text: prompt, sequence: sequence}:
		return nil
	}
}

func (w *queuedPromptWriter) AcknowledgeOnWrite() bool {
	return false
}

func (w *queuedPromptWriter) Interrupt() (bool, error) {
	w.controller.Interrupt()
	return true, nil
}

type structuredTurnController struct {
	mu         sync.Mutex
	generation uint64
	cancel     context.CancelFunc
}

func (c *structuredTurnController) Start(parent context.Context) (context.Context, func()) {
	turnCtx, cancel := context.WithCancel(parent)
	c.mu.Lock()
	c.generation++
	generation := c.generation
	c.cancel = cancel
	c.mu.Unlock()
	return turnCtx, func() {
		c.mu.Lock()
		if c.generation == generation {
			c.cancel = nil
		}
		c.mu.Unlock()
		cancel()
	}
}

func (c *structuredTurnController) Interrupt() bool {
	c.mu.Lock()
	cancel := c.cancel
	c.cancel = nil
	c.mu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

func (r *Runner) runStructuredTurns(
	ctx context.Context,
	harness string,
	mode string,
	argv0 string,
	initialPrompt string,
	runTurn structuredTurnRunner,
) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	_ = r.client.Event(ctx, "agent.started", map[string]any{
		"harness": harness,
		"argv0":   argv0,
		"mode":    mode,
	})

	heartbeatCtx, cancelHeartbeat := context.WithCancel(runCtx)
	var heartbeatWG sync.WaitGroup
	heartbeatWG.Add(1)
	go func() {
		defer heartbeatWG.Done()
		r.heartbeatLoop(heartbeatCtx)
	}()

	prompts := make(chan structuredPrompt, 256)
	turnController := &structuredTurnController{}
	commandCtx, cancelCommands := context.WithCancel(runCtx)
	var commandWG sync.WaitGroup
	commandWG.Add(1)
	go func() {
		defer commandWG.Done()
		r.structuredCommandLoop(commandCtx, &queuedPromptWriter{
			ctx:        commandCtx,
			prompts:    prompts,
			controller: turnController,
		})
	}()

	defer func() {
		cancelHeartbeat()
		cancelCommands()
		heartbeatWG.Wait()
		commandWG.Wait()
		_ = r.client.Event(context.Background(), "agent.exited", map[string]any{"exitCode": 0})
	}()

	sessionID := r.bootstrap.Launch.Session.AgentSessionID
	nextPrompt := structuredPrompt{}
	if sessionID == "" && strings.TrimSpace(initialPrompt) != "" {
		nextPrompt.text = initialPrompt
	}
	for {
		if nextPrompt.text == "" {
			select {
			case <-ctx.Done():
				return nil
			case nextPrompt = <-prompts:
			}
		}

		turnCtx, finishTurn := turnController.Start(runCtx)
		_ = r.client.Event(ctx, "chat.turn_started", map[string]any{
			"sessionId": sessionID,
		})
		nextSessionID, err := runTurn(
			turnCtx,
			nextPrompt.text,
			sessionID,
			nextPrompt.sequence,
		)
		interrupted := turnCtx.Err() != nil && runCtx.Err() == nil
		finishTurn()
		nextPrompt = structuredPrompt{}
		if nextSessionID != "" {
			sessionID = nextSessionID
		}
		if interrupted {
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			r.emitStructuredError(ctx, err)
			_ = r.client.Event(ctx, "chat.turn_completed", map[string]any{
				"isError": true,
				"error":   err.Error(),
			})
			continue
		}
		if sessionID == "" {
			r.emitStructuredError(ctx, fmt.Errorf(
				"%s structured protocol completed without a resumable session ID",
				harness,
			))
		}
	}
}

func (r *Runner) reportTurnInterrupted(ctx context.Context, sequence int64) error {
	delay := 250 * time.Millisecond
	for {
		err := r.client.Event(ctx, "chat.turn_interrupted", map[string]any{
			"requestSequence": sequence,
		})
		if err == nil {
			return nil
		}
		if !waitForRetry(ctx, delay) {
			return ctx.Err()
		}
		if delay < 4*time.Second {
			delay *= 2
		}
	}
}

func (r *Runner) runStructuredProcess(
	ctx context.Context,
	provider string,
	argv []string,
	environment []string,
	reportedError func() bool,
	stream func(context.Context, io.Reader) error,
	onStarted func(context.Context) error,
) error {
	turnCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	command := exec.CommandContext(turnCtx, argv[0], argv[1:]...)
	command.Dir = r.workspaceDir
	command.Env = environment
	stdout, err := command.StdoutPipe()
	if err != nil {
		return fmt.Errorf("open %s stdout: %w", provider, err)
	}
	stderr := newTailBuffer(maxClaudeStderr)
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("start structured %s runtime: %w", provider, err)
	}
	if onStarted != nil {
		if err := onStarted(turnCtx); err != nil {
			return fmt.Errorf("acknowledge %s prompt: %w", provider, err)
		}
	}

	readErr := stream(turnCtx, stdout)
	if readErr != nil {
		cancel()
	}
	waitErr := command.Wait()
	if readErr != nil && !errors.Is(readErr, io.EOF) && ctx.Err() == nil {
		return fmt.Errorf("read structured %s output: %w", provider, readErr)
	}
	if waitErr != nil && ctx.Err() == nil && !reportedError() {
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return fmt.Errorf("%s turn failed: %s", provider, message)
		}
		return fmt.Errorf("%s turn failed: %w", provider, waitErr)
	}
	return nil
}

func (r *Runner) acknowledgePromptUntil(ctx context.Context, sequence int64) error {
	if sequence <= 0 {
		return nil
	}
	delay := 250 * time.Millisecond
	for {
		if err := r.acknowledgePrompt(ctx, sequence); err == nil {
			return nil
		}
		if !waitForRetry(ctx, delay) {
			return ctx.Err()
		}
		if delay < 4*time.Second {
			delay *= 2
		}
	}
}

func (r *Runner) emitStructuredError(ctx context.Context, err error) {
	message := strings.TrimSpace(err.Error())
	if message == "" {
		message = "structured agent runtime failed"
	}
	_ = r.client.Event(ctx, "chat.error", map[string]any{"message": message})
	if isAuthenticationError(message) {
		_ = r.client.Event(ctx, "chat.auth_status", map[string]any{
			"status":  "invalid",
			"message": message,
		})
	}
}

func isAuthenticationError(message string) bool {
	lower := strings.ToLower(message)
	for _, marker := range []string{
		"api key is invalid",
		"invalid api key",
		"not logged in",
		"unauthorized",
		"authentication failed",
		"oauth",
		"status 401",
		"http 401",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
