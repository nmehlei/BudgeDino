import { act, render } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { AppState, type AppStateStatus } from 'react-native';

import { NotificationPoller } from '../NotificationPoller';
import * as pollTask from '../poll-task';

const mockOnSignOut = jest.fn(() => jest.fn());
jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-task-manager', () => ({ defineTask: jest.fn(), isTaskRegisteredAsync: jest.fn() }));
jest.mock('expo-background-task', () => ({}));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));
jest.mock('../../session/instance', () => ({
  getSessionStore: () => ({ onSignOut: mockOnSignOut }),
}));
jest.mock('../poll-task', () => ({
  ensureNotificationChannel: jest.fn().mockResolvedValue(undefined),
  registerNotificationTask: jest.fn().mockResolvedValue(undefined),
  pollNotifications: jest.fn().mockResolvedValue('empty'),
  clearNotificationState: jest.fn(),
}));

let handler: ((s: AppStateStatus) => void) | null = null;
const flush = () => act(async () => undefined);

beforeEach(() => {
  jest.clearAllMocks();
  handler = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, h) => {
    handler = h as (s: AppStateStatus) => void;
    return { remove: jest.fn() } as never;
  });
});
afterEach(() => jest.restoreAllMocks());

describe('NotificationPoller', () => {
  it('registers the sign-out cleanup', async () => {
    jest
      .mocked(Notifications.getPermissionsAsync)
      .mockResolvedValue({ granted: true, canAskAgain: true } as never);
    await render(<NotificationPoller />);
    await flush();
    expect(mockOnSignOut).toHaveBeenCalledTimes(1);
    const hook = (mockOnSignOut.mock.calls[0] as unknown as [() => void])[0];
    hook();
    expect(pollTask.clearNotificationState).toHaveBeenCalled();
  });

  it('sets up the channel and task, polls on mount and on every return to the foreground', async () => {
    jest
      .mocked(Notifications.getPermissionsAsync)
      .mockResolvedValue({ granted: true, canAskAgain: true } as never);
    await render(<NotificationPoller />);
    await flush();
    expect(pollTask.ensureNotificationChannel).toHaveBeenCalled();
    expect(pollTask.registerNotificationTask).toHaveBeenCalled();
    expect(pollTask.pollNotifications).toHaveBeenCalledTimes(1);

    await act(() => handler?.('background'));
    expect(pollTask.pollNotifications).toHaveBeenCalledTimes(1);
    await act(() => handler?.('active'));
    expect(pollTask.pollNotifications).toHaveBeenCalledTimes(2);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('asks for the permission when it was never decided', async () => {
    jest
      .mocked(Notifications.getPermissionsAsync)
      .mockResolvedValue({ granted: false, canAskAgain: true } as never);
    jest
      .mocked(Notifications.requestPermissionsAsync)
      .mockResolvedValue({ granted: true, canAskAgain: true } as never);
    await render(<NotificationPoller />);
    await flush();
    await flush();
    expect(pollTask.ensureNotificationChannel).toHaveBeenCalled();
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('does not nag once the permission was denied for good', async () => {
    jest
      .mocked(Notifications.getPermissionsAsync)
      .mockResolvedValue({ granted: false, canAskAgain: false } as never);
    await render(<NotificationPoller />);
    await flush();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });
});
