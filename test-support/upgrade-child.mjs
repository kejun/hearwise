import { ListeningStore } from '../storage.mjs';
try { const store = new ListeningStore(process.argv[2]); store.close(); }
catch (error) { console.error(JSON.stringify({ code: error.code, errcode: error.errcode, message: error.message })); process.exitCode = 1; }
