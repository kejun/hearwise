const { protocol } = JSON.parse(process.argv[2]);
if (protocol === 'knowledge') await import('./process-crash-knowledge-worker.mjs');
else if (protocol === 'relation') await import('./process-crash-relation-worker.mjs');
else throw new Error(`Unsupported process crash protocol: ${protocol}`);
