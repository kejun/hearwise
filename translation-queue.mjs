// 翻译任务调度：实时最终句与后台补齐共享并发额度。
// 规则（docs issue #1 §7.1）：
// 1. 全部翻译任务共享总额度（默认 2 并发）；新任务在空闲槽位立即启动，不等待节流定时器。
// 2. 当前活跃 run 最近 REALTIME_WINDOW 个待译最终句优先，窗口内按源序启动；其余最终句与历史重试为后台任务，按 FIFO。
// 3. 连续派发 REALTIME_STREAK_LIMIT 个实时任务后，若最早后台任务已等待 BACKGROUND_STARVE_MS，下一槽位让给最老后台任务。
// 4. 每个任务在队列中只保留一个身份（按 segment.id 去重）；内存清单设上限，完整待办依靠 SQLite pending 状态恢复。
// 本模块不做 I/O，时间与任务来源均可注入，便于确定性测试。
export const TRANSLATION_CONCURRENCY = 2;
const REALTIME_WINDOW = 2;
const REALTIME_STREAK_LIMIT = 3;
const BACKGROUND_STARVE_MS = 10000;
const QUEUE_CAP = 500;

export function createTranslationScheduler({ concurrency = TRANSLATION_CONCURRENCY, now = () => Date.now() } = {}) {
  const queue = [];
  const queuedIds = new Set();
  let realtimeWindow = [];
  let realtimeStreak = 0;

  function take(task) {
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
    queuedIds.delete(task.segment.id);
    if (realtimeWindow[0] === task) realtimeWindow.shift();
    return task;
  }
  return {
    concurrency,
    get length() { return queue.length; },
    has: id => queuedIds.has(id),
    hasListening: listeningId => queue.some(task => task.listeningId === listeningId),
    enqueue(task) {
      if (queuedIds.has(task.segment.id)) return false;
      queuedIds.add(task.segment.id);
      task.enqueuedAt = now();
      queue.push(task);
      if (queue.length > QUEUE_CAP) {
        const oldest = queue.findIndex(item => item.kind === 'background');
        if (oldest >= 0) {
          const [dropped] = queue.splice(oldest, 1);
          queuedIds.delete(dropped.segment.id);
          dropped.dropped = true;
        }
      }
      return true;
    },
    remove(listeningId) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].listeningId !== listeningId) continue;
        queuedIds.delete(queue[i].segment.id);
        queue.splice(i, 1);
      }
      realtimeWindow = realtimeWindow.filter(task => task.listeningId !== listeningId);
    },
    next() {
      if (!queue.length) return null;
      const currentTime = now();
      const oldestBackground = queue.find(task => task.kind === 'background');
      if (realtimeStreak >= REALTIME_STREAK_LIMIT && oldestBackground && currentTime - oldestBackground.enqueuedAt >= BACKGROUND_STARVE_MS) {
        realtimeStreak = 0;
        return take(oldestBackground);
      }
      realtimeWindow = realtimeWindow.filter(task => queue.includes(task));
      if (!realtimeWindow.length) {
        const reals = queue.filter(task => task.kind === 'realtime');
        if (reals.length) realtimeWindow = reals.slice(-REALTIME_WINDOW);
      }
      if (realtimeWindow.length) {
        realtimeStreak++;
        return take(realtimeWindow[0]);
      }
      realtimeStreak = 0;
      return take(queue[0]);
    }
  };
}
