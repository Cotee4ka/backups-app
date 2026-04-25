export type UserId = string;
export type ProjectId = string;
export type ServerId = string;
export type CommitSha = string;

export type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface User {
  id: UserId;
  username: string;
  role: UserRole;
  createdAt: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface RegisterRequest {
  username: string;
  password: string;
  inviteCode?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  user: User;
  tokens: AuthTokens;
}

export interface ServerConnection {
  id: ServerId;
  name: string;
  url: string;
  fingerprint: string;
  username: string;
  accessToken: string;
  refreshToken: string;
  lastConnectedAt?: number;
}

export interface Project {
  id: ProjectId;
  name: string;
  description?: string;
  defaultBranch: string;
  createdAt: number;
  createdBy: UserId;
  fileCount?: number;
  totalSize?: number;
  lastCommitSha?: CommitSha;
  lastCommitAt?: number;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
}

export interface ProjectMember {
  userId: UserId;
  username: string;
  role: UserRole;
  joinedAt: number;
}

export interface CommitInfo {
  sha: CommitSha;
  parentShas: CommitSha[];
  message: string;
  authorId: UserId;
  authorName: string;
  timestamp: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  insertions: number;
  deletions: number;
  patch?: string;
}

export interface CommitDetail extends CommitInfo {
  files: FileDiff[];
}

export interface AuditEntry {
  id: number;
  timestamp: number;
  userId: UserId;
  username: string;
  projectId: ProjectId;
  action: 'push' | 'pull' | 'restore' | 'project.create' | 'project.delete' | 'member.add' | 'member.remove';
  detail: Record<string, unknown>;
}

export interface RestoreRequest {
  sha: CommitSha;
  strategy: 'revert' | 'reset';
}

export interface ProjectConfig {
  ignore?: string[];
  include?: string[];
  postClone?: string[];
  runOnOpen?: string[];
}

export interface InstallStatus {
  step: string;
  progress: number;
  message: string;
  done: boolean;
  error?: string;
}

export interface InstallResult {
  serverUrl: string;
  fingerprint: string;
  adminUsername: string;
  adminPassword: string;
  adminToken: string;
}

export interface SshCredentials {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}
