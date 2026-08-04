// Package ecs implements AO sandbox lifecycle operations using AWS ECS Fargate.
package ecs

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsecs "github.com/aws/aws-sdk-go-v2/service/ecs"
	"github.com/aws/aws-sdk-go-v2/service/ecs/types"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudsandbox "github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

// Config contains deployment-level ECS/Fargate settings.
type Config struct {
	Cluster        string
	TaskDefinition string
	ContainerName  string
	Subnets        []string
	SecurityGroups []string
	AssignPublicIP bool
}

type ecsAPI interface {
	RunTask(context.Context, *awsecs.RunTaskInput, ...func(*awsecs.Options)) (*awsecs.RunTaskOutput, error)
	DescribeTasks(context.Context, *awsecs.DescribeTasksInput, ...func(*awsecs.Options)) (*awsecs.DescribeTasksOutput, error)
	ListTasks(context.Context, *awsecs.ListTasksInput, ...func(*awsecs.Options)) (*awsecs.ListTasksOutput, error)
	StopTask(context.Context, *awsecs.StopTaskInput, ...func(*awsecs.Options)) (*awsecs.StopTaskOutput, error)
}

// Client implements sandbox lifecycle operations with one Fargate task per session.
type Client struct {
	api            ecsAPI
	cluster        string
	taskDefinition string
	containerName  string
	subnets        []string
	securityGroups []string
	assignPublicIP types.AssignPublicIp
}

var _ cloudsandbox.Provider = (*Client)(nil)
var _ cloudsandbox.Recreator = (*Client)(nil)

// New creates an ECS/Fargate sandbox client.
func New(api ecsAPI, cfg Config) (*Client, error) {
	cfg.Cluster = strings.TrimSpace(cfg.Cluster)
	cfg.TaskDefinition = strings.TrimSpace(cfg.TaskDefinition)
	cfg.ContainerName = strings.TrimSpace(cfg.ContainerName)
	if cfg.ContainerName == "" {
		cfg.ContainerName = "worker"
	}
	cfg.Subnets = compact(cfg.Subnets)
	cfg.SecurityGroups = compact(cfg.SecurityGroups)
	if api == nil {
		return nil, errors.New("ecs API client is required")
	}
	if cfg.Cluster == "" {
		return nil, errors.New("ecs cluster is required")
	}
	if cfg.TaskDefinition == "" {
		return nil, errors.New("ecs task definition is required")
	}
	if len(cfg.Subnets) == 0 {
		return nil, errors.New("ecs subnets are required")
	}
	assignPublicIP := types.AssignPublicIpDisabled
	if cfg.AssignPublicIP {
		assignPublicIP = types.AssignPublicIpEnabled
	}
	return &Client{
		api:            api,
		cluster:        cfg.Cluster,
		taskDefinition: cfg.TaskDefinition,
		containerName:  cfg.ContainerName,
		subnets:        cfg.Subnets,
		securityGroups: cfg.SecurityGroups,
		assignPublicIP: assignPublicIP,
	}, nil
}

// Create runs one Fargate task for the session.
func (c *Client) Create(ctx context.Context, spec cloudsandbox.Spec) (cloudsandbox.Environment, error) {
	environment := make([]types.KeyValuePair, 0, len(spec.Environment))
	for key, value := range spec.Environment {
		k := key
		v := value
		environment = append(environment, types.KeyValuePair{Name: &k, Value: &v})
	}
	input := &awsecs.RunTaskInput{
		Cluster:        aws.String(c.cluster),
		TaskDefinition: aws.String(c.taskDefinition),
		LaunchType:     types.LaunchTypeFargate,
		Count:          aws.Int32(1),
		StartedBy:      aws.String(startedBy(spec.SessionID)),
		NetworkConfiguration: &types.NetworkConfiguration{
			AwsvpcConfiguration: &types.AwsVpcConfiguration{
				AssignPublicIp: c.assignPublicIP,
				SecurityGroups: c.securityGroups,
				Subnets:        c.subnets,
			},
		},
		Overrides: &types.TaskOverride{
			ContainerOverrides: []types.ContainerOverride{
				{
					Name:        aws.String(c.containerName),
					Environment: environment,
				},
			},
		},
		Tags: []types.Tag{
			{Key: aws.String("ao.session_id"), Value: aws.String(string(spec.SessionID))},
			{Key: aws.String("ao.managed"), Value: aws.String("true")},
		},
	}
	output, err := c.api.RunTask(ctx, input)
	if err != nil {
		return cloudsandbox.Environment{}, fmt.Errorf("run ECS task: %w", err)
	}
	if len(output.Failures) > 0 {
		return cloudsandbox.Environment{}, fmt.Errorf("run ECS task failed: %s", formatFailures(output.Failures))
	}
	if len(output.Tasks) != 1 || output.Tasks[0].TaskArn == nil {
		return cloudsandbox.Environment{}, errors.New("run ECS task returned no task ARN")
	}
	return taskEnvironment(output.Tasks[0]), nil
}

// Get returns the current state of an ECS task.
func (c *Client) Get(ctx context.Context, id cloudsandbox.ID) (cloudsandbox.Environment, error) {
	task, err := c.describeOne(ctx, string(id))
	if err != nil {
		return cloudsandbox.Environment{}, err
	}
	return taskEnvironment(task), nil
}

// FindBySession finds an ECS task started for an AO session.
func (c *Client) FindBySession(
	ctx context.Context,
	sessionID clouddomain.SessionID,
) (cloudsandbox.Environment, bool, error) {
	output, err := c.api.ListTasks(ctx, &awsecs.ListTasksInput{
		Cluster:   aws.String(c.cluster),
		StartedBy: aws.String(startedBy(sessionID)),
	})
	if err != nil {
		return cloudsandbox.Environment{}, false, fmt.Errorf("list ECS tasks: %w", err)
	}
	if len(output.TaskArns) == 0 {
		return cloudsandbox.Environment{}, false, nil
	}
	task, err := c.describeOne(ctx, output.TaskArns[0])
	if err != nil {
		return cloudsandbox.Environment{}, false, err
	}
	return taskEnvironment(task), true, nil
}

// Start cannot restart a stopped Fargate task without a fresh launch spec.
func (c *Client) Start(context.Context, cloudsandbox.ID) error {
	return errors.New("ECS Fargate tasks cannot be started in place")
}

// Stop stops a Fargate task.
func (c *Client) Stop(ctx context.Context, id cloudsandbox.ID) error {
	return c.stop(ctx, id, "AO requested stop")
}

// Pause stops the task; Fargate does not support process suspension.
func (c *Client) Pause(ctx context.Context, id cloudsandbox.ID) error {
	return c.stop(ctx, id, "AO requested pause")
}

// Resume cannot resume a stopped Fargate task without a fresh launch spec.
func (c *Client) Resume(context.Context, cloudsandbox.ID) error {
	return errors.New("ECS Fargate tasks cannot be resumed in place")
}

// Delete stops a Fargate task. ECS eventually removes stopped task metadata.
func (c *Client) Delete(ctx context.Context, id cloudsandbox.ID) error {
	return c.stop(ctx, id, "AO requested delete")
}

// Recreate stops the old task and launches a fresh Fargate task with new bootstrap credentials.
func (c *Client) Recreate(ctx context.Context, id cloudsandbox.ID, spec cloudsandbox.Spec) (cloudsandbox.Environment, error) {
	if err := c.stop(ctx, id, "AO requested recreate"); err != nil && !errors.Is(err, cloudsandbox.ErrNotFound) {
		return cloudsandbox.Environment{}, err
	}
	return c.Create(ctx, spec)
}

func (c *Client) describeOne(ctx context.Context, taskARN string) (types.Task, error) {
	output, err := c.api.DescribeTasks(ctx, &awsecs.DescribeTasksInput{
		Cluster: aws.String(c.cluster),
		Tasks:   []string{taskARN},
	})
	if err != nil {
		return types.Task{}, fmt.Errorf("describe ECS task: %w", err)
	}
	if len(output.Failures) > 0 {
		return types.Task{}, fmt.Errorf("describe ECS task failed: %s", formatFailures(output.Failures))
	}
	if len(output.Tasks) == 0 {
		return types.Task{}, cloudsandbox.ErrNotFound
	}
	return output.Tasks[0], nil
}

func (c *Client) stop(ctx context.Context, id cloudsandbox.ID, reason string) error {
	if strings.TrimSpace(string(id)) == "" {
		return cloudsandbox.ErrNotFound
	}
	_, err := c.api.StopTask(ctx, &awsecs.StopTaskInput{
		Cluster: aws.String(c.cluster),
		Task:    aws.String(string(id)),
		Reason:  aws.String(reason),
	})
	if err != nil {
		return fmt.Errorf("stop ECS task: %w", err)
	}
	return nil
}

func taskEnvironment(task types.Task) cloudsandbox.Environment {
	state := ecsState(task.LastStatus)
	id := ""
	if task.TaskArn != nil {
		id = *task.TaskArn
	}
	name := id
	if task.Group != nil && strings.HasPrefix(*task.Group, "family:") {
		name = strings.TrimPrefix(*task.Group, "family:")
	}
	return cloudsandbox.Environment{
		ID:    cloudsandbox.ID(id),
		Name:  name,
		State: state,
	}
}

func ecsState(value *string) string {
	switch strings.ToUpper(strings.TrimSpace(aws.ToString(value))) {
	case "PROVISIONING", "PENDING", "ACTIVATING":
		return "creating"
	case "RUNNING":
		return "running"
	case "DEACTIVATING", "STOPPING", "DEPROVISIONING":
		return "deleting"
	case "STOPPED":
		return "stopped"
	default:
		return "provisioning"
	}
}

func startedBy(sessionID clouddomain.SessionID) string {
	return "ao-" + string(sessionID)
}

func compact(values []string) []string {
	out := values[:0]
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func formatFailures(failures []types.Failure) string {
	parts := make([]string, 0, len(failures))
	for _, failure := range failures {
		parts = append(parts, strings.TrimSpace(aws.ToString(failure.Arn)+" "+aws.ToString(failure.Reason)+" "+aws.ToString(failure.Detail)))
	}
	return strings.Join(parts, "; ")
}
