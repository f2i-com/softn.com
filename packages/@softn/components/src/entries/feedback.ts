/**
 * What a page says in passing and what it lays over itself: alerts, toasts,
 * modals, drawers, popovers, confirmations and tooltips. Fetched the first
 * time a page draws one; EmptyState is in the start-up set.
 */
export * from '../feedback/Alert';
export * from '../feedback/Modal';
export * from '../feedback/Toast';
export * from '../feedback/Drawer';
export * from '../feedback/Popover';
export * from '../feedback/Confirm';
export * from '../utility/Tooltip';

import { Alert } from '../feedback/Alert';
import { Modal } from '../feedback/Modal';
import { Toast } from '../feedback/Toast';
import { Drawer } from '../feedback/Drawer';
import { Popover } from '../feedback/Popover';
import { Confirm } from '../feedback/Confirm';
import { Tooltip } from '../utility/Tooltip';

export const feedbackComponents = { Alert, Modal, Toast, Drawer, Popover, Confirm, Tooltip };
