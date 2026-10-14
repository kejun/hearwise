// Consume native node:test events, not stdout. A test printing JSON cannot
// impersonate this channel. Keep original locations and parent/child identities.
export default async function* (events) {
  for await (const event of events) if (['test:pass', 'test:fail', 'test:plan', 'test:summary'].includes(event.type)) yield JSON.stringify(event) + '\n';
}
