package ecs

import (
	"context"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsecs "github.com/aws/aws-sdk-go-v2/service/ecs"
	"github.com/aws/aws-sdk-go-v2/service/ecs/types"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

type fakeECS struct {
	runInput     *awsecs.RunTaskInput
	describeTask types.Task
	listARNs     []string
	stopInput    *awsecs.StopTaskInput
}

func (f *fakeECS) RunTask(
	_ context.Context,
	input *awsecs.RunTaskInput,
	_ ...func(*awsecs.Options),
) (*awsecs.RunTaskOutput, error) {
	f.runInput = input
	return &awsecs.RunTaskOutput{
		Tasks: []types.Task{{
			TaskArn:    aws.String("arn:aws:ecs:task/one"),
			LastStatus: aws.String("PENDING"),
			Group:      aws.String("family:ao-worker"),
		}},
	}, nil
}

func (f *fakeECS) DescribeTasks(
	_ context.Context,
	_ *awsecs.DescribeTasksInput,
	_ ...func(*awsecs.Options),
) (*awsecs.DescribeTasksOutput, error) {
	return &awsecs.DescribeTasksOutput{Tasks: []types.Task{f.describeTask}}, nil
}

func (f *fakeECS) ListTasks(
	_ context.Context,
	_ *awsecs.ListTasksInput,
	_ ...func(*awsecs.Options),
) (*awsecs.ListTasksOutput, error) {
	return &awsecs.ListTasksOutput{TaskArns: f.listARNs}, nil
}

func (f *fakeECS) StopTask(
	_ context.Context,
	input *awsecs.StopTaskInput,
	_ ...func(*awsecs.Options),
) (*awsecs.StopTaskOutput, error) {
	f.stopInput = input
	return &awsecs.StopTaskOutput{}, nil
}

func TestCreateRunsFargateTaskWithWorkerEnvironment(t *testing.T) {
	api := &fakeECS{}
	client, err := New(api, Config{
		Cluster:        "cluster",
		TaskDefinition: "task:1",
		ContainerName:  "worker",
		Subnets:        []string{"subnet-one"},
		SecurityGroups: []string{"sg-one"},
		AssignPublicIP: true,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	environment, err := client.Create(context.Background(), cloudsandbox.Spec{
		SessionID: "session-one",
		Environment: map[string]string{
			"AO_CLOUD_PUBLIC_URL":       "https://cloud.example",
			"AO_WORKER_BOOTSTRAP_TOKEN": "ticket",
		},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if environment.ID != "arn:aws:ecs:task/one" || environment.State != "creating" {
		t.Fatalf("environment = %#v", environment)
	}
	input := api.runInput
	if input == nil {
		t.Fatal("RunTask was not called")
	}
	if input.LaunchType != types.LaunchTypeFargate {
		t.Fatalf("LaunchType = %q", input.LaunchType)
	}
	if aws.ToString(input.StartedBy) != "ao-session-one" {
		t.Fatalf("StartedBy = %q", aws.ToString(input.StartedBy))
	}
	if input.NetworkConfiguration == nil ||
		input.NetworkConfiguration.AwsvpcConfiguration == nil ||
		input.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp != types.AssignPublicIpEnabled {
		t.Fatalf("NetworkConfiguration = %#v", input.NetworkConfiguration)
	}
	if got := strings.Join(input.NetworkConfiguration.AwsvpcConfiguration.Subnets, ","); got != "subnet-one" {
		t.Fatalf("Subnets = %q", got)
	}
	override := input.Overrides.ContainerOverrides[0]
	if aws.ToString(override.Name) != "worker" {
		t.Fatalf("Container override name = %q", aws.ToString(override.Name))
	}
	values := map[string]string{}
	for _, pair := range override.Environment {
		values[aws.ToString(pair.Name)] = aws.ToString(pair.Value)
	}
	if values["AO_WORKER_BOOTSTRAP_TOKEN"] != "ticket" {
		t.Fatalf("worker bootstrap token env = %q", values["AO_WORKER_BOOTSTRAP_TOKEN"])
	}
}

func TestFindBySessionReturnsListedTask(t *testing.T) {
	api := &fakeECS{
		listARNs: []string{"arn:aws:ecs:task/one"},
		describeTask: types.Task{
			TaskArn:    aws.String("arn:aws:ecs:task/one"),
			LastStatus: aws.String("RUNNING"),
		},
	}
	client := testClient(t, api)
	environment, found, err := client.FindBySession(context.Background(), clouddomain.SessionID("session-one"))
	if err != nil {
		t.Fatalf("FindBySession() error = %v", err)
	}
	if !found {
		t.Fatal("FindBySession() found = false")
	}
	if environment.State != "running" {
		t.Fatalf("State = %q", environment.State)
	}
}

func TestDeleteStopsTask(t *testing.T) {
	api := &fakeECS{}
	client := testClient(t, api)
	if err := client.Delete(context.Background(), "arn:aws:ecs:task/one"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if api.stopInput == nil || aws.ToString(api.stopInput.Task) != "arn:aws:ecs:task/one" {
		t.Fatalf("StopTask input = %#v", api.stopInput)
	}
}

func testClient(t *testing.T, api *fakeECS) *Client {
	t.Helper()
	client, err := New(api, Config{
		Cluster:        "cluster",
		TaskDefinition: "task:1",
		ContainerName:  "worker",
		Subnets:        []string{"subnet-one"},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return client
}
