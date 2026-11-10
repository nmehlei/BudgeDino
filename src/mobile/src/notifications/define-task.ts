import { defineNotificationTask } from './poll-task';

// Imported first by index.ts so the headless background task exists on a cold WorkManager start,
// before expo-router (and any React code) loads. No UI imports here.
defineNotificationTask();
