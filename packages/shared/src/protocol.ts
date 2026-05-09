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
  | 'lock:acquired'
  | 'lock:heartbeat'
  | 'lock:released'
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

/**
 * Координация Claude-агентов / людей: один лок на проект, видимость
 * статуса всем подписчикам. Холдер шлёт heartbeat'ы (с currentlyEditing —
 * тем что сейчас правит локально), сервер ретранслирует.
 */
export interface ProjectLockState {
  projectId: ProjectId;
  holderUserId: UserId;
  holderUsername: string;
  reason: string;
  acquiredAt: number;
  expiresAt: number;
  heartbeatAt: number;
  /** Что холдер сейчас правит локально (из dirty-сета sync-engine'а). */
  currentlyEditing: string[];
  /** Файлы, тронутые за всю сессию (из push'ей после acquire). */
  sessionFiles: string[];
}

export interface LockAcquiredMessage extends BaseMessage<'lock:acquired'> {
  lock: ProjectLockState;
}

export interface LockHeartbeatMessage extends BaseMessage<'lock:heartbeat'> {
  lock: ProjectLockState;
}

export interface LockReleasedMessage extends BaseMessage<'lock:released'> {
  projectId: ProjectId;
  byUserId: UserId;
  /** Свободный текст: что сделано за сессию. Холдер пишет на release. */
  summary?: string;
  /** Финальный список файлов сессии — для краткого «что трогали». */
  sessionFiles?: string[];
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
  | LockAcquiredMessage
  | LockHeartbeatMessage
  | LockReleasedMessage
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
