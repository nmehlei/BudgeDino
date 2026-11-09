import { v7 } from 'uuid';

/** UUID v7 (time-ordered) primary key, generated in the application so it can be bound as AAD. */
export function newId(): string {
  return v7();
}
