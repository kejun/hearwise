// Consume arbitrary process-output chunks without retaining the full log.
export function onceOutputContains(marker, onMatch) {
  let pending = '', matched = false;
  return text => {
    if (matched) return;
    const output = pending + text;
    if (!output.includes(marker)) {
      pending = marker.length > 1 ? output.slice(1 - marker.length) : '';
      return;
    }
    pending = '';
    matched = true;
    onMatch();
  };
}
