// Bitbucket Cloud REST API v2.0 response types

export interface BbPaginatedResponse<T> {
  pagelen: number;
  size?: number;
  page?: number;
  next?: string;
  previous?: string;
  values: T[];
}

export interface BbUser {
  display_name: string;
  uuid: string;
  nickname?: string;
  type: string;
  account_id?: string;
}

export interface BbBranch {
  name: string;
}

export interface BbCommit {
  hash: string;
  date?: string;
}

export interface BbPullRequest {
  id: number;
  title: string;
  description: string;
  state: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
  source: {
    branch: BbBranch | null; // null when fork repo is deleted
    commit: BbCommit | null;
    repository?: { full_name: string };
  } | null;
  destination: {
    branch: BbBranch | null;
    commit?: BbCommit | null;
  } | null;
  author: BbUser;
  participants: BbParticipant[];
  close_source_branch: boolean;
  created_on: string;
  updated_on: string;
  comment_count: number;
  task_count: number;
  merge_commit?: BbCommit | null;
  links: {
    html: { href: string };
    diff?: { href: string };
    diffstat?: { href: string };
  };
}

export interface BbParticipant {
  user: BbUser;
  role: "PARTICIPANT" | "REVIEWER" | "AUTHOR";
  approved: boolean;
  state: "approved" | "changes_requested" | null;
}

export interface BbCommitStatus {
  key: string;
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED";
  name: string;
  url: string;
  description?: string;
  created_on: string;
  updated_on: string;
}

export interface BbComment {
  id: number;
  content: { raw: string; markup: string; html?: string };
  user: BbUser;
  created_on: string;
  updated_on: string;
  inline?: {
    from?: number | null;
    to?: number | null;
    path: string;
  };
  parent?: { id: number };
  deleted: boolean;
  resolution?: { user: BbUser; created_on: string } | null;
  links: { html: { href: string } };
}

export interface BbDiffstatEntry {
  type: string;
  status: string;
  lines_added: number;
  lines_removed: number;
  old?: { path: string };
  new?: { path: string };
}
