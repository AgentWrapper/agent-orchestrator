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
	listInput    *awsecs.ListTasksInput
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
	input *awsecs.ListTasksInput,
	_ ...func(*awsecs.Options),
) (*awsecs.ListTasksOutput, error) {
	f.listInput = input
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
		SessionID:       "session-one",
		ResourceProfile: clouddomain.ResourceProfile{CPU: 8, Memory: 16, Disk: 20},
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
	if input.ClientToken != nil {
		t.Fatalf("ClientToken = %q, want unset for recreatable session", aws.ToString(input.ClientToken))
	}
	if aws.ToString(input.Overrides.Cpu) != "8192" || aws.ToString(input.Overrides.Memory) != "16384" {
		t.Fatalf("resource overrides = cpu %q memory %q", aws.ToString(input.Overrides.Cpu), aws.ToString(input.Overrides.Memory))
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

func TestCreateWarmTaskContainsNoTenantIdentity(t *testing.T) {
	api := &fakeECS{}
	client := testClient(t, api)
	_, err := client.CreateWarmTask(
		context.Background(),
		"pool-task-one",
		"release-one",
		"https://cloud.example",
		"unique-enrollment-token",
		clouddomain.DefaultResourceProfile(),
	)
	if err != nil {
		t.Fatalf("CreateWarmTask() error = %v", err)
	}
	if got := aws.ToString(api.runInput.StartedBy); got != "ao-warm-pool-task-one" {
		t.Fatalf("StartedBy = %q", got)
	}
	if got := aws.ToString(api.runInput.ClientToken); got != "ao-warm-pool-task-one" {
		t.Fatalf("ClientToken = %q", got)
	}
	values := map[string]string{}
	for _, pair := range api.runInput.Overrides.ContainerOverrides[0].Environment {
		values[aws.ToString(pair.Name)] = aws.ToString(pair.Value)
	}
	if values["AO_WORKER_WARM_POOL"] != "true" ||
		values["AO_WORKER_BOOTSTRAP_TOKEN"] != "unique-enrollment-token" {
		t.Fatalf("warm environment = %#v", values)
	}
	for _, forbidden := range []string{"AO_CLOUD_SESSION_ID", "AO_ACCOUNT_ID", "GITHUB_TOKEN"} {
		if _, ok := values[forbidden]; ok {
			t.Fatalf("warm environment contains %s", forbidden)
		}
	}
	if aws.ToString(api.runInput.Overrides.Cpu) != "4096" ||
		aws.ToString(api.runInput.Overrides.Memory) != "8192" {
		t.Fatalf(
			"warm resources = cpu %q memory %q",
			aws.ToString(api.runInput.Overrides.Cpu),
			aws.ToString(api.runInput.Overrides.Memory),
		)
	}
}

func TestFindWarmTaskUsesPoolReservationIdentity(t *testing.T) {
	api := &fakeECS{
		listARNs: []string{"arn:aws:ecs:task/warm"},
		describeTask: types.Task{
			TaskArn:    aws.String("arn:aws:ecs:task/warm"),
			LastStatus: aws.String("RUNNING"),
		},
	}
	client := testClient(t, api)
	environment, found, err := client.FindWarmTask(context.Background(), "pool-task-one")
	if err != nil {
		t.Fatalf("FindWarmTask() error = %v", err)
	}
	if !found || environment.State != "running" {
		t.Fatalf("environment = %#v, found = %v", environment, found)
	}
	if got := aws.ToString(api.listInput.StartedBy); got != "ao-warm-pool-task-one" {
		t.Fatalf("StartedBy = %q", got)
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
