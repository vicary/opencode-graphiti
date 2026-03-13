import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import manifest from "../../deno.json" with { type: "json" };
import { logger } from "./logger.ts";

export type GraphitiConnectionState =
  | "connecting"
  | "connected"
  | "offline"
  | "closing";

type TimerHandle = ReturnType<typeof setTimeout> | number;

export class GraphitiOfflineError extends Error {
  readonly kind = "offline";

  constructor(readonly state: "offline" | "closing", message?: string) {
    super(
      message ??
        (state === "closing"
          ? "Graphiti connection manager is closing"
          : "Graphiti connection manager is offline"),
    );
    this.name = "GraphitiOfflineError";
  }
}

export class GraphitiQueueTimeoutError extends Error {
  readonly kind = "queue-timeout";

  constructor(
    message = "Graphiti request timed out while waiting for connection",
  ) {
    super(message);
    this.name = "GraphitiQueueTimeoutError";
  }
}

export class GraphitiRequestTimeoutError extends Error {
  readonly kind = "request-timeout";

  constructor(message = "Graphiti request timed out") {
    super(message);
    this.name = "GraphitiRequestTimeoutError";
  }
}

export class GraphitiTransportError extends Error {
  readonly kind = "transport-failure";

  constructor(message = "Graphiti transport failure") {
    super(message);
    this.name = "GraphitiTransportError";
  }
}

export class GraphitiSessionExpiredError extends Error {
  readonly kind = "session-expired";

  constructor(message = "Graphiti session expired") {
    super(message);
    this.name = "GraphitiSessionExpiredError";
  }
}

export function isGraphitiOfflineError(
  err: unknown,
): err is GraphitiOfflineError {
  return err instanceof GraphitiOfflineError;
}

export function isGraphitiTimeoutError(
  err: unknown,
): err is GraphitiQueueTimeoutError | GraphitiRequestTimeoutError {
  return err instanceof GraphitiQueueTimeoutError ||
    err instanceof GraphitiRequestTimeoutError;
}

export type GraphitiToolRequest = {
  name: string;
  arguments?: Record<string, unknown>;
};

export interface GraphitiConnection {
  connect(): Promise<void>;
  close(): Promise<void>;
  callTool(request: GraphitiToolRequest): Promise<unknown>;
}

export interface GraphitiToolCaller {
  start(): void;
  stop(): Promise<void>;
  ready(timeoutMs?: number): Promise<boolean>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    deadlineMs?: number,
  ): Promise<unknown>;
}

type PendingRequest = {
  name: string;
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: TimerHandle | null;
};

type ConnectionFactory = (endpoint: string) => GraphitiConnection;

type GraphitiConnectionManagerOptions = {
  endpoint: string;
  requestDeadlineMs?: number;
  queueCapacity?: number;
  startupTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMultiplier?: number;
  reconnectJitter?: number;
  connectionFactory?: ConnectionFactory;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

function createMcpConnection(endpoint: string): GraphitiConnection {
  const client = new Client({
    name: manifest.name,
    version: manifest.version,
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));

  return {
    connect: () => client.connect(transport),
    close: () => client.close(),
    callTool: (request) => client.callTool(request),
  };
}

type RawErrorShape = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  name?: unknown;
};

function getErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return "";
  const { message, cause } = err as RawErrorShape;
  if (typeof message === "string") return message;
  if (cause) return getErrorMessage(cause);
  return "";
}

function isRequestTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return typeof err === "string" && /request timed out/i.test(err);
  }

  const { code } = err as RawErrorShape;
  return code === -32001 || /request timed out/i.test(getErrorMessage(err));
}

function isSessionExpired(err: unknown): boolean {
  return !!(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as RawErrorShape).code === 404
  );
}

function isTransportFailure(err: unknown): boolean {
  if (!err) return false;
  if (isRequestTimeout(err) || isSessionExpired(err)) return false;

  const message = getErrorMessage(err);
  if (
    /(socket hang up|fetch failed|network|connection reset|connection refused|econnrefused|terminated|broken pipe|stream closed|unexpected end|transport)/i
      .test(message)
  ) {
    return true;
  }

  if (typeof err === "object") {
    const { name } = err as RawErrorShape;
    return name === "TypeError" && message.length > 0;
  }

  return false;
}

export class GraphitiConnectionManager implements GraphitiToolCaller {
  private readonly endpoint: string;
  private readonly requestDeadlineMs: number;
  private readonly queueCapacity: number;
  private readonly startupTimeoutMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectMultiplier: number;
  private readonly reconnectJitter: number;
  private readonly connectionFactory: ConnectionFactory;
  private readonly random: () => number;
  private readonly setTimerImpl: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimerImpl: (timer: TimerHandle) => void;

  private state: GraphitiConnectionState = "offline";
  private connection: GraphitiConnection | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private pendingRequests: PendingRequest[] = [];
  private readyWaiters = new Set<(value: boolean) => void>();
  private reconnectDelayMs: number;
  private started = false;
  private flushingQueue = false;

  constructor(options: GraphitiConnectionManagerOptions) {
    this.endpoint = options.endpoint;
    this.requestDeadlineMs = options.requestDeadlineMs ?? 15_000;
    this.queueCapacity = options.queueCapacity ?? 32;
    this.startupTimeoutMs = options.startupTimeoutMs ?? this.requestDeadlineMs;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 60_000;
    this.reconnectMultiplier = options.reconnectMultiplier ?? 2;
    this.reconnectJitter = options.reconnectJitter ?? 0.25;
    this.connectionFactory = options.connectionFactory ?? createMcpConnection;
    this.random = options.random ?? Math.random;
    this.setTimerImpl = options.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimerImpl = options.clearTimer ??
      ((timer) => clearTimeout(timer));
    this.reconnectDelayMs = this.reconnectInitialDelayMs;
  }

  getState(): GraphitiConnectionState {
    return this.state;
  }

  start(): void {
    if (this.started || this.state === "closing") return;
    this.started = true;
    void this.reconnect();
  }

  async stop(): Promise<void> {
    if (this.state === "closing") return;

    this.started = false;
    this.state = "closing";
    this.cancelReconnectTimer();
    this.rejectAllPending(
      new GraphitiOfflineError(
        "closing",
        "Graphiti connection manager stopped",
      ),
    );
    this.resolveReadyWaiters(false);

    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        await connection.close();
      } catch {
        // Ignore close errors while shutting down.
      }
    }
  }

  async ready(timeoutMs = this.startupTimeoutMs): Promise<boolean> {
    if (this.state === "connected") return true;
    if (this.state === "closing") return false;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: TimerHandle | null = null;

      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.clearTimerImpl(timer);
        this.readyWaiters.delete(finish);
        resolve(value);
      };

      this.readyWaiters.add(finish);

      if (timeoutMs >= 0) {
        timer = this.setTimerImpl(() => finish(false), timeoutMs);
      }
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    deadlineMs = this.requestDeadlineMs,
  ): Promise<unknown> {
    const sanitizedArgs = Object.fromEntries(
      Object.entries(args).filter(([_, value]) =>
        value !== null && value !== undefined
      ),
    );

    if (this.state === "closing") {
      throw new GraphitiOfflineError("closing");
    }

    if (this.state === "offline") {
      throw new GraphitiOfflineError("offline");
    }

    if (this.state === "connecting") {
      return await this.enqueueRequest(name, sanitizedArgs, deadlineMs);
    }

    return await this.executeConnectedCall(name, sanitizedArgs);
  }

  async reconnect(): Promise<boolean> {
    if (this.state === "closing") return false;
    if (this.connectPromise) return await this.connectPromise;

    this.cancelReconnectTimer();
    this.state = "connecting";

    const attempt = this.performReconnect();
    this.connectPromise = attempt.finally(() => {
      this.connectPromise = null;
    });

    return await this.connectPromise;
  }

  private async performReconnect(): Promise<boolean> {
    const previousConnection = this.connection;
    this.connection = null;

    if (previousConnection) {
      try {
        await previousConnection.close();
      } catch {
        // Ignore stale close failures during reconnect.
      }
    }

    const nextConnection = this.connectionFactory(this.endpoint);

    try {
      await nextConnection.connect();

      if (this.state === "closing") {
        try {
          await nextConnection.close();
        } catch {
          // Ignore close failures while shutting down.
        }
        return false;
      }

      this.connection = nextConnection;
      this.state = "connected";
      this.reconnectDelayMs = this.reconnectInitialDelayMs;
      this.resolveReadyWaiters(true);
      logger.info("Connected to Graphiti MCP server at", this.endpoint);
      void this.flushPendingQueue();
      return true;
    } catch (err) {
      try {
        await nextConnection.close();
      } catch {
        // Ignore close failures for failed connects.
      }

      if (this.state !== "closing") {
        this.state = "offline";
        this.rejectAllPending(new GraphitiOfflineError("offline"));
        this.scheduleReconnect();
        logger.warn("Failed to connect to Graphiti MCP server", err);
      }

      return false;
    }
  }

  private async executeConnectedCall(
    name: string,
    args: Record<string, unknown>,
    attempt = 0,
  ): Promise<unknown> {
    if (this.state !== "connected" || !this.connection) {
      throw new GraphitiOfflineError("offline");
    }

    try {
      return await this.connection.callTool({ name, arguments: args });
    } catch (err) {
      if (isRequestTimeout(err)) {
        throw new GraphitiRequestTimeoutError(
          getErrorMessage(err) || undefined,
        );
      }

      if (isSessionExpired(err)) {
        const typedError = new GraphitiSessionExpiredError(
          getErrorMessage(err) || undefined,
        );

        if (attempt >= 1) {
          void this.reconnect();
          throw typedError;
        }

        const connected = await this.reconnect();
        if (!connected) throw typedError;
        return await this.executeConnectedCall(name, args, attempt + 1);
      }

      if (isTransportFailure(err)) {
        const typedError = new GraphitiTransportError(
          getErrorMessage(err) || undefined,
        );

        if (attempt >= 1) {
          void this.reconnect();
          throw typedError;
        }

        const connected = await this.reconnect();
        if (!connected) throw typedError;
        return await this.executeConnectedCall(name, args, attempt + 1);
      }

      throw err;
    }
  }

  private enqueueRequest(
    name: string,
    args: Record<string, unknown>,
    deadlineMs: number,
  ): Promise<unknown> {
    if (deadlineMs <= 0) {
      return Promise.reject(new GraphitiQueueTimeoutError());
    }

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        name,
        args,
        resolve,
        reject,
        timer: null,
      };

      pending.timer = this.setTimerImpl(() => {
        this.removePendingRequest(pending);
        reject(new GraphitiQueueTimeoutError());
      }, deadlineMs);

      if (this.pendingRequests.length >= this.queueCapacity) {
        const dropped = this.pendingRequests.shift();
        if (dropped) {
          this.clearPendingTimer(dropped);
          dropped.reject(
            new GraphitiQueueTimeoutError(
              "Graphiti request dropped because the connecting queue is full",
            ),
          );
        }
      }

      this.pendingRequests.push(pending);
    });
  }

  private async flushPendingQueue(): Promise<void> {
    if (this.flushingQueue || this.state !== "connected") return;

    this.flushingQueue = true;
    try {
      while (this.state === "connected" && this.pendingRequests.length > 0) {
        const next = this.pendingRequests.shift();
        if (!next) continue;

        this.clearPendingTimer(next);

        try {
          const result = await this.executeConnectedCall(next.name, next.args);
          next.resolve(result);
        } catch (err) {
          next.reject(err);
        }
      }
    } finally {
      this.flushingQueue = false;
    }
  }

  private removePendingRequest(target: PendingRequest): void {
    const index = this.pendingRequests.indexOf(target);
    if (index >= 0) {
      this.pendingRequests.splice(index, 1);
    }
    this.clearPendingTimer(target);
  }

  private clearPendingTimer(request: PendingRequest): void {
    if (request.timer !== null) {
      this.clearTimerImpl(request.timer);
      request.timer = null;
    }
  }

  private rejectAllPending(error: Error): void {
    const pending = [...this.pendingRequests];
    this.pendingRequests = [];

    for (const request of pending) {
      this.clearPendingTimer(request);
      request.reject(error);
    }
  }

  private scheduleReconnect(): void {
    if (
      !this.started || this.state === "closing" || this.reconnectTimer !== null
    ) {
      return;
    }

    const jitterFactor = 1 + ((this.random() * 2) - 1) * this.reconnectJitter;
    const delayMs = Math.max(
      0,
      Math.round(this.reconnectDelayMs * jitterFactor),
    );

    this.reconnectTimer = this.setTimerImpl(() => {
      this.reconnectTimer = null;
      if (this.state === "closing") return;
      void this.reconnect();
    }, delayMs);

    this.reconnectDelayMs = Math.min(
      this.reconnectMaxDelayMs,
      Math.max(
        this.reconnectInitialDelayMs,
        Math.round(this.reconnectDelayMs * this.reconnectMultiplier),
      ),
    );
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimerImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resolveReadyWaiters(value: boolean): void {
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const waiter of waiters) {
      waiter(value);
    }
  }
}
