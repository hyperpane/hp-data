// The object family's tabs and tree menus: a bucket opens in a Finder-like
// browser (BucketView.tsx); the connection's menu makes a bucket, a
// bucket's copies its s3:// URL (and, on AWS, its console page).

import { createElement } from 'react';
import type { TreeActions, Views } from '../../app/tabs.ts';
import { BucketView } from './bucket.tsx';
import { s3Uri } from './ops.ts';

export const views: Views = {
  bucket: (p) => createElement(BucketView, { key: `${p.connection.id}:${p.tab.ref.bucket}`, ...p }),
};

export const actions: TreeActions = (c) => {
  if (!c.node) {
    if (c.readOnly) return [];
    return [
      {
        label: 'New Bucket',
        run: () =>
          void (async () => {
            const name = (await c.api.prompt('New bucket', 'Name (3–63 lowercase letters, digits, dots, hyphens)', '', 'my-bucket'))?.trim();
            if (!name) return;
            await c.api.call('objCreateBucket', { id: c.connection.id, project: c.project ?? undefined, bucket: name });
            c.api.toast(`Made bucket ${name}`);
            c.refresh();
            c.open({ type: 'bucket', conn: c.connection.id, ref: { bucket: name }, title: name });
          })().catch(c.api.fail),
      },
    ];
  }
  if (c.node.type !== 'bucket') return [];
  const bucket = c.node.name;
  return [
    { label: 'Copy s3:// URL', run: () => c.api.copy(s3Uri(bucket), 'the s3:// URL') },
    ...(c.kind.id === 's3'
      ? [
          {
            label: 'Copy AWS Console Link',
            run: () => c.api.copy(`https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(bucket)}`, 'the console link'),
          },
        ]
      : []),
  ];
};
