// The client part: the Data window. Every connection is made by the server
// part, on the server, not from this frame.

import { mount } from '@hyperpane/sdk/client';
import { NodeMessage } from '@hyperpane/ui';
import { DataView } from './app/view.tsx';

mount((host) =>
  host.view.type === 'node' && host.view.kind === 'data' ? <DataView /> : <NodeMessage error>Data has no “{host.view.type}” view here.</NodeMessage>,
);
