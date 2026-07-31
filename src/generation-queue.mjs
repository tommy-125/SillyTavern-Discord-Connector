/**
 * Strict FIFO queue for operations that mutate SillyTavern's one active
 * frontend state. A watchdog can abort a stuck task, but the queue does not
 * release the next task until the aborted task has actually settled. If abort
 * is ignored, the caller can reload the browser through onUnresponsive rather
 * than allowing two generations to mutate SillyTavern concurrently.
 */
export class GenerationQueueTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Generation task timed out after ${timeoutMs} ms`);
    this.name = 'GenerationQueueTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function createGenerationQueue() {
  let tail = Promise.resolve();
  let pendingCount = 0;

  function enqueue(task, options = {}) {
    if (typeof task !== 'function') {
      return Promise.reject(
        new TypeError('Generation queue task must be a function'),
      );
    }

    pendingCount += 1;
    const result = tail.then(async () => {
      const timeoutMs = Number(options.timeoutMs) || 0;
      const unresponsiveGraceMs = Number(options.unresponsiveGraceMs) || 10_000;
      const abortController = new AbortController();
      let timeoutId = null;
      let unresponsiveId = null;
      let settled = false;

      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          const error = new GenerationQueueTimeoutError(timeoutMs);
          abortController.abort(error);
          options.onTimeout?.(error);
          if (typeof options.onUnresponsive === 'function') {
            unresponsiveId = setTimeout(() => {
              if (!settled) options.onUnresponsive(error);
            }, unresponsiveGraceMs);
          }
        }, timeoutMs);
      }

      try {
        return await task({
          signal: abortController.signal,
          abortController,
        });
      } finally {
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (unresponsiveId) clearTimeout(unresponsiveId);
        pendingCount -= 1;
      }
    });

    // Preserve the caller's rejection while keeping the internal chain alive
    // so a failed generation cannot permanently block later messages.
    tail = result.catch(() => undefined);

    return result;
  }

  return {
    enqueue,
    whenIdle: () => tail,
    getPendingCount: () => pendingCount,
  };
}

const globalGenerationQueue = createGenerationQueue();

export const enqueueGenerationTask = (task, options) =>
  globalGenerationQueue.enqueue(task, options);
export const whenGenerationQueueIdle = () =>
  globalGenerationQueue.whenIdle();
export const getGenerationQueueSize = () =>
  globalGenerationQueue.getPendingCount();
