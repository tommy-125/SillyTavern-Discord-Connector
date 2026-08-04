"use strict";

/**
 * Schedules SillyTavern generation packets across independent browser pages.
 * A channel can have only one active task, while unrelated channels may use
 * different workers concurrently.
 */
function createWorkerPool({ isOpen, log = () => {} } = {}) {
  const workers = new Map();
  const queue = [];
  const activeChannels = new Set();
  const requestToWorker = new Map();

  const socketIsOpen =
    typeof isOpen === "function"
      ? isOpen
      : (socket) => Boolean(socket && socket.readyState === 1);

  function connectedWorkers() {
    return [...workers.values()].filter((worker) => socketIsOpen(worker.socket));
  }

  function idleWorkers() {
    return connectedWorkers().filter((worker) => !worker.task && !worker.draining);
  }

  function removeQueuedRequest(requestId) {
    const index = queue.findIndex((task) => task.requestId === requestId);
    if (index < 0) return null;
    return queue.splice(index, 1)[0];
  }

  function pickRunnableTaskIndex() {
    return queue.findIndex((task) => !activeChannels.has(task.channelId));
  }

  function dispatch() {
    for (const worker of idleWorkers()) {
      const taskIndex = pickRunnableTaskIndex();
      if (taskIndex < 0) break;
      const task = queue.splice(taskIndex, 1)[0];
      worker.task = task;
      worker.lastAssignedAt = Date.now();
      activeChannels.add(task.channelId);
      requestToWorker.set(task.requestId, worker.id);
      try {
        worker.socket.send(JSON.stringify(task.payload));
        log(
          "info",
          `[Workers] Assigned requestId=${task.requestId} channelId=${task.channelId} workerId=${worker.id}; ${queue.length} queued.`,
        );
      } catch (error) {
        worker.task = null;
        activeChannels.delete(task.channelId);
        requestToWorker.delete(task.requestId);
        queue.unshift(task);
        workers.delete(worker.id);
        log("warn", `[Workers] ${worker.id} send failed: ${error.message}`);
      }
    }
  }

  function register(id, socket) {
    const workerId = String(id || "").trim();
    if (!workerId) throw new Error("Worker ID is required.");
    const previous = workers.get(workerId);
    if (previous && previous.socket !== socket) {
      unregister(workerId, previous.socket, { requeue: true });
      try {
        previous.socket.close(1008, "Replaced by a newer worker connection");
      } catch {}
    }
    workers.set(workerId, {
      id: workerId,
      socket,
      task: null,
      draining: false,
      connectedAt: Date.now(),
      lastAssignedAt: 0,
    });
    log("log", `[Workers] ${workerId} connected (${connectedWorkers().length} ready).`);
    dispatch();
  }

  function unregister(id, socket, { requeue = true } = {}) {
    const workerId = String(id || "").trim();
    const worker = workers.get(workerId);
    if (!worker || (socket && worker.socket !== socket)) return false;
    workers.delete(workerId);
    if (worker.task) {
      const task = worker.task;
      activeChannels.delete(task.channelId);
      requestToWorker.delete(task.requestId);
      if (requeue && task.attempts < 1) {
        queue.unshift({ ...task, attempts: task.attempts + 1 });
        log(
          "warn",
          `[Workers] ${workerId} disconnected during ${task.requestId.slice(-8)}; queued one retry.`,
        );
      } else {
        task.onDrop?.(new Error(`SillyTavern worker ${workerId} disconnected.`));
      }
    }
    log("warn", `[Workers] ${workerId} disconnected (${connectedWorkers().length} ready).`);
    dispatch();
    return true;
  }

  function enqueue({ channelId, requestId, payload, onDrop }) {
    const normalizedChannelId = String(channelId || "").trim();
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedChannelId || !normalizedRequestId || !payload) return false;
    if (requestToWorker.has(normalizedRequestId)) return true;
    if (queue.some((task) => task.requestId === normalizedRequestId)) return true;
    if (connectedWorkers().length === 0) return false;
    queue.push({
      channelId: normalizedChannelId,
      requestId: normalizedRequestId,
      payload,
      onDrop,
      attempts: 0,
      enqueuedAt: Date.now(),
    });
    dispatch();
    return true;
  }

  function complete(workerId, requestId) {
    const worker = workers.get(String(workerId || ""));
    const normalizedRequestId = String(requestId || "");
    if (!worker?.task || worker.task.requestId !== normalizedRequestId) {
      return false;
    }
    const task = worker.task;
    worker.task = null;
    activeChannels.delete(task.channelId);
    requestToWorker.delete(task.requestId);
    dispatch();
    return true;
  }

  function abandon(workerId, requestId) {
    const worker = workers.get(String(workerId || ""));
    const normalizedRequestId = String(requestId || "");
    if (!worker?.task || worker.task.requestId !== normalizedRequestId) {
      return false;
    }
    const task = worker.task;
    worker.task = null;
    worker.draining = true;
    activeChannels.delete(task.channelId);
    requestToWorker.delete(task.requestId);
    dispatch();
    return true;
  }

  function sendToWorker(workerId, payload) {
    const worker = workers.get(String(workerId || ""));
    if (!worker || !socketIsOpen(worker.socket)) return false;
    worker.socket.send(JSON.stringify(payload));
    return true;
  }

  function sendToAny(payload) {
    const candidates = connectedWorkers().sort((left, right) => {
      if (Boolean(left.task) !== Boolean(right.task)) return left.task ? 1 : -1;
      return left.lastAssignedAt - right.lastAssignedAt;
    });
    if (candidates.length === 0) return false;
    return sendToWorker(candidates[0].id, payload);
  }

  function broadcast(payload) {
    const sent = [];
    for (const worker of connectedWorkers()) {
      if (sendToWorker(worker.id, payload)) sent.push(worker.id);
    }
    return sent;
  }

  function cancel(requestId) {
    const queued = removeQueuedRequest(String(requestId || ""));
    if (queued) {
      queued.onDrop?.(new Error("Generation request was cancelled."));
      return true;
    }
    return false;
  }

  function snapshot() {
    return {
      connected: connectedWorkers().length,
      busy: connectedWorkers().filter((worker) => worker.task).length,
      queued: queue.length,
      workers: connectedWorkers().map((worker) => ({
        id: worker.id,
        busy: Boolean(worker.task),
        draining: worker.draining,
        requestId: worker.task?.requestId || null,
        channelId: worker.task?.channelId || null,
      })),
    };
  }

  return {
    register,
    unregister,
    enqueue,
    complete,
    abandon,
    cancel,
    sendToWorker,
    sendToAny,
    broadcast,
    hasWorkers: () => connectedWorkers().length > 0,
    workerIds: () => connectedWorkers().map((worker) => worker.id),
    firstSocket: () => connectedWorkers()[0]?.socket || null,
    snapshot,
  };
}

module.exports = { createWorkerPool };
