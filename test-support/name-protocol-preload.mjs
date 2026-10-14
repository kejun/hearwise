// Only isolated test children load this module; no production option or endpoint.
import { ListeningStore } from '../storage.mjs';
const moduleUrl = process.env.NAME_PROTOCOL_MUTATION_MODULE;
if (!moduleUrl) throw new Error('Missing explicit name-protocol negative module');
Object.assign(ListeningStore.prototype, (await import(moduleUrl)).knowledgeNameReplacementMethods);
