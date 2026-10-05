// Prints what ensureFreshToken() returns. session.test.mjs runs two of these at once.
import { ensureFreshToken } from '../../dist/config.js';

process.stdout.write((await ensureFreshToken()) ?? '');
