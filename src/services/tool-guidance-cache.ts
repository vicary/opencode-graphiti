import type { ToolGuidanceType } from "./tool-guidance.ts";

export class ToolGuidanceCache {
  private readonly emittedBySession = new Map<string, Set<ToolGuidanceType>>();

  shouldEmit(sessionId: string, guidanceType: ToolGuidanceType): boolean {
    const emitted = this.emittedBySession.get(sessionId);
    if (emitted?.has(guidanceType)) return false;

    const next = emitted ?? new Set<ToolGuidanceType>();
    next.add(guidanceType);
    this.emittedBySession.set(sessionId, next);
    return true;
  }

  clearSession(sessionId: string): void {
    this.emittedBySession.delete(sessionId);
  }

  clearAll(): void {
    this.emittedBySession.clear();
  }
}
