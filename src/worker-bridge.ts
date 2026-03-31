import type { WorkerRequest, WorkerResponse, WorkerProgressEvent } from "./worker-types.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export type ProgressCallback = (event: { step: string; stepIndex: number; totalSteps: number }) => void;

export class WorkerBridge {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private progressHandlers = new Map<number, ProgressCallback>();

  constructor(workerUrl: string | URL) {
    this.worker = new Worker(workerUrl);

    this.worker.onmessage = (event: MessageEvent<WorkerResponse | WorkerProgressEvent>) => {
      const data = event.data;

      // Route progress events to handler
      if (data.type === "progress") {
        const prog = data as WorkerProgressEvent;
        const handler = this.progressHandlers.get(prog.requestId);
        if (handler) {
          handler({ step: prog.step, stepIndex: prog.stepIndex, totalSteps: prog.totalSteps });
        }
        return;
      }

      // Normal response
      const { id, result, error } = data as WorkerResponse;
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      this.progressHandlers.delete(id);
      if (error) {
        call.reject(new Error(error.message));
      } else {
        call.resolve(result);
      }
    };

    this.worker.onerror = (event: ErrorEvent) => {
      const err = new Error(event.message || "Worker error");
      for (const call of this.pending.values()) {
        call.reject(err);
      }
      this.pending.clear();
      this.progressHandlers.clear();
    };
  }

  call(method: string, params: Record<string, unknown> = {}, transfer?: Transferable[], onProgress?: ProgressCallback): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      if (onProgress) {
        this.progressHandlers.set(id, onProgress);
      }

      const msg: WorkerRequest = { id, method, params };

      // Extract buffer from params for transfer
      if (params.buffer instanceof ArrayBuffer) {
        msg.buffer = params.buffer;
        delete params.buffer;
      }

      if (transfer && transfer.length > 0) {
        this.worker.postMessage(msg, transfer);
      } else {
        this.worker.postMessage(msg);
      }
    });
  }

  terminate(): void {
    const err = new Error("Worker terminated");
    for (const call of this.pending.values()) {
      call.reject(err);
    }
    this.pending.clear();
    this.progressHandlers.clear();
    this.worker.terminate();
  }
}
