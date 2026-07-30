package worker

import (
	"context"
	"testing"
)

func TestStructuredTurnInterruptCancelsOnlyCurrentTurn(t *testing.T) {
	controller := &structuredTurnController{}
	first, finishFirst := controller.Start(context.Background())
	if !controller.Interrupt() {
		t.Fatal("Interrupt() = false for active turn")
	}
	<-first.Done()
	finishFirst()

	second, finishSecond := controller.Start(context.Background())
	defer finishSecond()
	if second.Err() != nil {
		t.Fatalf("future turn inherited cancellation: %v", second.Err())
	}
}

func TestStructuredTurnOldCleanupDoesNotClearReplacement(t *testing.T) {
	controller := &structuredTurnController{}
	_, finishFirst := controller.Start(context.Background())
	second, finishSecond := controller.Start(context.Background())
	defer finishSecond()

	finishFirst()
	if !controller.Interrupt() {
		t.Fatal("old cleanup cleared replacement turn")
	}
	<-second.Done()
}

func TestQueuedInterruptAcknowledgesIdleWorker(t *testing.T) {
	writer := &queuedPromptWriter{controller: &structuredTurnController{}}
	interrupted, err := writer.Interrupt()
	if err != nil {
		t.Fatal(err)
	}
	if !interrupted {
		t.Fatal("idle interrupt was not acknowledged")
	}
}
