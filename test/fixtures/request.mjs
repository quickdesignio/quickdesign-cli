// Prints what request(<path>) returns, as JSON. retry.test.mjs runs two of these at once.
import { request } from '../../dist/client.js';

process.stdout.write(JSON.stringify(await request(process.argv[2])));
