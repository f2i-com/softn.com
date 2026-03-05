/**
 * Notification Store - Toast notifications for the builder
 */

import { create } from 'zustand';

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  duration: number; // ms
}

interface NotificationStore {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'id'>) => void;
  removeNotification: (id: string) => void;
  clearAll: () => void;
}

let notifCounter = 0;

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],

  addNotification: (notification) => {
    const id = `notif_${Date.now()}_${notifCounter++}`;
    const entry: Notification = { ...notification, id };

    set((state) => ({
      notifications: [...state.notifications, entry],
    }));

    // Auto-remove after duration
    if (entry.duration > 0) {
      setTimeout(() => {
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== id),
        }));
      }, entry.duration);
    }
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  clearAll: () => {
    set({ notifications: [] });
  },
}));

// Convenience functions
export const toast = {
  success: (message: string) =>
    useNotificationStore.getState().addNotification({ type: 'success', message, duration: 3000 }),
  error: (message: string) =>
    useNotificationStore.getState().addNotification({ type: 'error', message, duration: 5000 }),
  warning: (message: string) =>
    useNotificationStore.getState().addNotification({ type: 'warning', message, duration: 4000 }),
  info: (message: string) =>
    useNotificationStore.getState().addNotification({ type: 'info', message, duration: 3000 }),
};
