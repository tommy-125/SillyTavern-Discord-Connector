/**
 * Strict FIFO queue for operations that mutate SillyTavern's one active
 * frontend state. It intentionally has no timeout release: starting another
 * task while a stuck generation is still active would corrupt shared state.
 */
export function createGenerationQueue() {
  let tail = Promise.resolve();
  let pendingCount = 0;

  function enqueue(task) {
    if (typeof task !== 'function') {
      return Promise.reject(
        new TypeError('Generation queue task must be a function'),
      );
    }

    pendingCount += 1;
    const result = tail.then(async () => {
      try {
        return await task();
      } finally {
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

export const enqueueGenerationTask = (task) =>
  globalGenerationQueue.enqueue(task);
export const whenGenerationQueueIdle = () =>
  globalGenerationQueue.whenIdle();
export const getGenerationQueueSize = () =>
  globalGenerationQueue.getPendingCount();
