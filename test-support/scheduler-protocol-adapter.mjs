import { createTranslationServiceAdapter } from './scheduler-service-adapter.mjs';
import { createKnowledgeSchedulerAdapter } from './scheduler-knowledge-adapter.mjs';

export async function createSchedulerProtocolAdapter(config) {
  if (config.kind === 'knowledge') return createKnowledgeSchedulerAdapter(config);
  const service = await createTranslationServiceAdapter(config);
  let state = await service.observe();
  return { act: async action => { state = await service.act(action); }, observe: () => state,
    project: () => ({ queue: state.queue, running: state.running, phase: state.phase, interim: state.service.interim, recentStarts: state.recentStarts }),
    check: () => {
      const violations = [];
      if (state.service.final !== state.running.length || state.service.active !== state.running.length) violations.push('service_final_count_mismatch');
      if (state.service.final + state.service.interim > state.service.concurrency) violations.push('shared_budget_exceeded');
      if (state.service.queueLength !== state.queue.length) violations.push('queue_membership_mismatch');
      return violations;
    }, close: service.close };
}
