import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { databasePath } from "./database-path.js";

const WORKER_COUNT = 8;
const MAX_QUEUE = 128;
const QUERY_TIMEOUT_MS = 1000;
const QUERY_DEADLINE_MS = 5000;

export class QueryOverloadedError extends Error {
  status = 503;
  code = "QUERY_OVERLOADED";
  retryAfterSeconds = 1;

  constructor(message = "当前查询人数较多，请稍后重试") {
    super(message);
  }
}

export class QueryTimeoutError extends Error {
  status = 503;
  code = "QUERY_TIMEOUT";
  retryAfterSeconds = 1;

  constructor(message = "查询耗时较长，请稍后重试") {
    super(message);
  }
}

export class QueryQueueTimeoutError extends Error {
  status = 503;
  code = "QUERY_QUEUE_TIMEOUT";
  retryAfterSeconds = 1;

  constructor(message = "查询等待时间过长，请稍后重试") {
    super(message);
  }
}

function cacheKey(operation, query) {
  return `${operation}:${JSON.stringify(query || {})}`;
}

export function createQueryWorkerPool(options = {}) {
  const workers = [];
  const queue = [];
  const cache = new Map();
  const inflight = new Map();
  let cacheEpoch = 0;
  const pending = new Map();
  const ttlByOperation = {
    assignedTasks: 1000,
    assignedTaskOptions: 60000,
    scorerDashboard: 2000,
    ...(options.ttlByOperation || {}),
  };

  function spawn(index) {
    const worker = new Worker(new URL("./query-worker.js", import.meta.url), {
      workerData: {
        databasePath: options.databasePath || databasePath,
        taskVersion: options.taskVersion || "v3",
        taskCriteria: options.taskCriteria || [],
        scoreNumericFields: options.scoreNumericFields || [],
        skippableScoreFields: options.skippableScoreFields || [],
        imageSelectColumns: options.imageSelectColumns || "*",
      },
    });
    const slot = { index, worker, busy: false, retiring: false, requestId: null };
    workers[index] = slot;
    worker.on("online", drain);
    worker.on("message", (message) => finish(slot, message));
    worker.on("error", (error) => failWorker(slot, error));
    worker.on("exit", (code) => {
      if (workers[index] !== slot) return;
      if (code !== 0) failWorker(slot, new Error(`查询 worker 退出（code ${code}）`));
      workers[index] = null;
      setImmediate(() => spawn(index));
    });
  }

  function failWorker(slot, error) {
    if (!slot.busy || !slot.requestId) return;
    const request = pending.get(slot.requestId);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(slot.requestId);
    slot.busy = false;
    slot.retiring = true;
    slot.requestId = null;
    request.reject(error);
    slot.worker.terminate().catch(() => {});
  }

  function finish(slot, message) {
    if (!slot.requestId) return;
    const request = pending.get(slot.requestId);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(slot.requestId);
    slot.busy = false;
    slot.retiring = false;
    slot.requestId = null;
    if (message.ok) {
      const ttl = ttlByOperation[request.operation] || 0;
      if (ttl && request.cacheEpoch === cacheEpoch) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(cacheKey(request.operation, request.query), {
          value: message.data,
          expiresAt: Date.now() + ttl,
        });
      }
      request.resolve(message.data);
    } else {
      const error = new Error(message.message || "查询失败");
      error.status = message.status || 500;
      error.code = message.code || "QUERY_FAILED";
      if (error.status === 503) error.retryAfterSeconds = 1;
      request.reject(error);
    }
    drain();
  }

  function timeout(slot, requestId) {
    if (slot.requestId !== requestId) return;
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    slot.busy = false;
    slot.retiring = true;
    slot.requestId = null;
    request.reject(new QueryTimeoutError());
    slot.worker.terminate().catch(() => {});
  }

  function dispatch(slot, request) {
    clearTimeout(request.queueTimer);
    const remainingMs = request.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      request.reject(new QueryQueueTimeoutError());
      return;
    }
    const requestId = crypto.randomUUID();
    slot.busy = true;
    slot.requestId = requestId;
    const timer = setTimeout(() => timeout(slot, requestId), Math.min(QUERY_TIMEOUT_MS, remainingMs));
    pending.set(requestId, { ...request, timer });
    slot.worker.postMessage({ requestId, operation: request.operation, query: request.query });
  }

  function drain() {
    for (const slot of workers) {
      if (!slot || slot.busy || slot.retiring) continue;
      let request = queue.shift();
      while (request && request.deadlineAt <= Date.now()) {
        clearTimeout(request.queueTimer);
        request.reject(new QueryQueueTimeoutError());
        request = queue.shift();
      }
      if (request) dispatch(slot, request);
    }
  }

  function run(operation, query = {}) {
    const key = cacheKey(operation, query);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
    if (cached) cache.delete(key);
    const existing = inflight.get(key);
    if (existing) return existing;
    if (queue.length >= MAX_QUEUE && !workers.some((slot) => slot && !slot.busy && !slot.retiring)) {
      return Promise.reject(new QueryOverloadedError());
    }
    const promise = new Promise((resolve, reject) => {
      const request = {
        operation,
        query,
        resolve,
        reject,
        cacheEpoch,
        deadlineAt: Date.now() + QUERY_DEADLINE_MS,
      };
      request.queueTimer = setTimeout(() => {
        const index = queue.indexOf(request);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(new QueryQueueTimeoutError());
      }, QUERY_DEADLINE_MS);
      queue.push(request);
      drain();
    });
    inflight.set(key, promise);
    promise.then(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    }, () => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    return promise;
  }

  function invalidate(operations = []) {
    cacheEpoch += 1;
    if (!operations.length) {
      cache.clear();
      inflight.clear();
      return;
    }
    for (const key of cache.keys()) {
      if (operations.some((operation) => key.startsWith(`${operation}:`))) cache.delete(key);
    }
    for (const key of inflight.keys()) {
      if (operations.some((operation) => key.startsWith(`${operation}:`))) inflight.delete(key);
    }
  }

  for (let index = 0; index < WORKER_COUNT; index += 1) spawn(index);

  return { run, invalidate };
}
