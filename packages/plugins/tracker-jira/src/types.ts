// Jira Cloud REST API v3 response types

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description: AdfNode | null;
    status: JiraStatus;
    issuetype: { id: string; name: string };
    priority?: { id: string; name: string };
    labels: string[];
    assignee: JiraUser | null;
    reporter?: JiraUser | null;
    project: { key: string; name: string };
    created: string;
    updated: string;
    comment?: {
      total: number;
      comments: JiraComment[];
    };
  };
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory: {
    id: number;
    key: "new" | "indeterminate" | "done" | string;
    name: string;
  };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
  hasScreen: boolean;
  fields?: Record<string, unknown>;
}

export interface JiraTransitionsResponse {
  transitions: JiraTransition[];
}

export interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

export interface JiraComment {
  id: string;
  author: JiraUser;
  body: AdfNode;
  created: string;
  updated: string;
}

export interface JiraCreateIssueResponse {
  id: string;
  key: string;
  self: string;
}

// ADF (Atlassian Document Format)
export interface AdfNode {
  type: string;
  version?: number;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}
