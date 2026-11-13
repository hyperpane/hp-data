// The server part: keeps the saved connections and a session for each one
// in use, and runs what the windows ask of them.

import { serve } from '@hyperpane/sdk/server';
import { plugin } from './plugin.ts';

serve(plugin);
