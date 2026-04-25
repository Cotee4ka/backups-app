import type { CommitSha, ProjectId, UserId } from './types.js';

/**
 * WebSocket-протокол сигналинга.
 *
 * ВАЖНО: WS используется ТОЛЬКО для уведомлений. Содержимое файлов
 * никогда не передаётся через WS — для этого используется git push/pull
 * по HTTPS с JWT-авторизацией.
 */

export type ClientMessageType =
  | 'auth'
  | 'project:subscribe'
  | 'project:unsubscribe'
  | 'repo:pushed'
  | 'presence:ping';

export type ServerMessageType =
  | 'auth:ok'
  | 'auth:error'
  | 'repo:updated'
  | 'project:restored'
  | 'project:deleted'
  | 'presence:join'
  | 'presence:leave'
  | 'presence:list'
  | 'error';

export interface BaseMessage<T extends string> {
  type: T;
  id?: string;
}

export interface AuthMessage extends BaseMessage<'auth'> {
  accessToken: string;
}

export interface ProjectSubscribeMessage extends BaseMessage<'project:subscribe'> {
  projectId: ProjectId;
}

export interface ProjectUnsubscribeMessage extends BaseMessage<'project:unsubscribe'> {
  projectId: ProjectId;
}

export interface RepoPushedMessage extends BaseMessage<'repo:pushed'> {
  projectId: ProjectId;
  sha: CommitSha;
}

export interface PresencePingMessage extends BaseMessage<'presence:ping'> {
  projectId?: ProjectId;
}

export type ClientMessage =
  | AuthMessage
  | ProjectSubscribeMessage
  | ProjectUnsubscribeMessage
  | RepoPushedMessage
  | PresencePingMessage;

export interface AuthOkMessage extends BaseMessage<'auth:ok'> {
  userId: UserId;
}

export interface AuthErrorMessage extends BaseMessage<'auth:error'> {
  reason: string;
}

export interface RepoUpdatedMessage extends BaseMessage<'repo:updated'> {
  projectId: ProjectId;
  sha: CommitSha;
  authorId: UserId;
  authorName: string;
  filesChanged: number;
  message: string;
  timestamp: number;
}

export interface ProjectRestoredMessage extends BaseMessage<'project:restored'> {
  projectId: ProjectId;
  sha: CommitSha;
  byUserId: UserId;
}

export interface ProjectDeletedMessage extends BaseMessage<'project:deleted'> {
  projectId: ProjectId;
}

export interface PresenceJoinMessage extends BaseMessage<'presence:join'> {
  projectId: ProjectId;
  userId: UserId;
  username: string;
}

export interface PresenceLeaveMessage extends BaseMessage<'presence:leave'> {
  projectId: ProjectId;
  userId: UserId;
}

export interface PresenceListMessage extends BaseMessage<'presence:list'> {
  projectId: ProjectId;
  users: { userId: UserId; username: string }[];
}

export interface ErrorMessage extends BaseMessage<'error'> {
  code: string;
  message: string;
}

export type ServerMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | RepoUpdatedMessage
  | ProjectRestoredMessage
  | ProjectDeletedMessage
  | PresenceJoinMessage
  | PresenceLeaveMessage
  | PresenceListMessage
  | ErrorMessage;

export type AnyMessage = ClientMessage | ServerMessage;

export function isClientMessage(msg: AnyMessage): msg is ClientMessage {
  const t = msg.type;
  return (
    t === 'auth' ||
    t === 'project:subscribe' ||
    t === 'project:unsubscribe' ||
    t === 'repo:pushed' ||
    t === 'presence:ping'
  );
}

export function isServerMessage(msg: AnyMessage): msg is ServerMessage {
  return !isClientMessage(msg);
}
