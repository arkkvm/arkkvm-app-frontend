export type ControlOwner = 'user' | 'agent' | null;

export interface ControlPending {
  requestId: string;
  requester: 'user' | 'agent';
  reason: string;
  deadlineMs: number;
  timeoutPolicy: 'grantRequester' | 'denyRequester';
}

export interface ControlState {
  owner: ControlOwner;
  pending: ControlPending | null;
}
