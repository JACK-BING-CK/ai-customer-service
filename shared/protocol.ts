import type { CommerceCard, CommerceState } from './commerce.ts';

export type Role = 'customer' | 'assistant' | 'agent' | 'system';
export type Mode = 'ai' | 'waiting' | 'human' | 'resolved';
export interface Message {
  id: string;
  role: Role;
  text: string;
  at: number;
  commerceCard?: CommerceCard;
}
export interface Snapshot {
  id: string;
  mode: Mode;
  version: number;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  generating: boolean;
  draft: string;
  commerce?: CommerceState;
  handoffReason?: string;
}
export interface Ack { ok: boolean; error?: string }
export interface Session { id: string; token: string }
