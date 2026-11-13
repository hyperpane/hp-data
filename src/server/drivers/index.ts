// The driver for each engine, loaded when first needed: a server that only
// ever opens SQLite never loads MongoDB's driver.

import type { Engine } from '../../shared/kinds.ts';
import type { Factory } from './types.ts';

const LOADERS: Record<Engine, () => Promise<Factory>> = {
  postgres: () => import('./sql/postgres.ts').then((m) => m.postgres),
  mysql: () => import('./sql/mysql.ts').then((m) => m.mysql),
  sqlite: () => import('./sql/sqlite.ts').then((m) => m.sqlite),
  clickhouse: () => import('./sql/clickhouse.ts').then((m) => m.clickhouse),
  redis: () => import('./kv/redis.ts').then((m) => m.redis),
  etcd: () => import('./kv/etcd.ts').then((m) => m.etcd),
  mongodb: () => import('./document/mongodb.ts').then((m) => m.mongodb),
  elasticsearch: () => import('./document/elasticsearch.ts').then((m) => m.elasticsearch),
  dynamodb: () => import('./document/dynamodb.ts').then((m) => m.dynamodb),
  kafka: () => import('./queue/kafka.ts').then((m) => m.kafka),
  rabbitmq: () => import('./queue/rabbitmq.ts').then((m) => m.rabbitmq),
  sqs: () => import('./queue/sqs.ts').then((m) => m.sqs),
  s3: () => import('./object/s3.ts').then((m) => m.s3),
};

export const factoryFor = (engine: Engine): Promise<Factory> => LOADERS[engine]();
