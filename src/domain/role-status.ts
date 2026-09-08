export const ROLE_STATUSES = [
  'new',
  'todo',
  'applied',
  'interviewing',
  'success',
  'denied',
  'skip',
] as const;

export type RoleStatus = (typeof ROLE_STATUSES)[number];

/** Statuses `cm roles list` shows by default — terminal states are hidden unless asked for explicitly. */
export const ACTIVE_ROLE_STATUSES: RoleStatus[] = ['new', 'todo', 'applied', 'interviewing'];
