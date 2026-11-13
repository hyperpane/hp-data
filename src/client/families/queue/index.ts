// The queue family's tabs (a Kafka topic; a RabbitMQ or SQS queue, or a
// RabbitMQ exchange: one tab for all, by what it can do) and its tree
// menus.

import type { TreeActions, Views } from '../../app/tabs.ts';
import { actions as queueActions } from './actions.ts';
import { QueueTab } from './tab.tsx';

export const views: Views = {
  topic: QueueTab,
  queue: QueueTab,
};

export const actions: TreeActions = queueActions;
