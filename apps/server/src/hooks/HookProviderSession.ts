import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface HookProviderSessionConfig {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly token: string;
}

const sessionsByThread = new Map<ThreadId, HookProviderSessionConfig>();

export function setHookProviderSession(config: HookProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readHookProviderSession(threadId: ThreadId): HookProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearHookProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllHookProviderSessions(): void {
  sessionsByThread.clear();
}

export function withHookProviderSessionEnvironment(
  environment: NodeJS.ProcessEnv,
  threadId: ThreadId,
): NodeJS.ProcessEnv {
  const session = readHookProviderSession(threadId);
  return {
    ...environment,
    T3_HOOK_APPROVAL_URL: session?.endpoint,
    T3_HOOK_APPROVAL_TOKEN: session?.token,
  };
}
