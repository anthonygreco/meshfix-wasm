export interface WorkerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
  buffer?: ArrayBuffer;
}

export interface WorkerResponse {
  id: number;
  type?: undefined;
  result?: unknown;
  error?: { message: string };
}

export interface WorkerProgressEvent {
  type: "progress";
  requestId: number;
  step: string;
  stepIndex: number;
  totalSteps: number;
}

export interface WorkerInitOptions {
  workerUrl?: string | URL;
  coreUrl?: string;
  wasmUrl?: string;
}
