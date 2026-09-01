import path from 'path';
import { installBundledSharedRuntime } from './utils';

// Must be the first import of every bin: the server modules require the shared package.
installBundledSharedRuntime(path.join(__dirname, '..'));
