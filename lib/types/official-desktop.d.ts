import type { CommandOptions, CommandResult, PluginRunner } from './commands.ts';
import type { DshRuntime } from './types.ts';
/** Structural Host service contract; no Electron or generated Client proxy dependency. */
export interface OfficialPluginManagerLike {
    installBundle(spec: string, options?: Record<string, unknown>): Promise<unknown>;
    removeBundle(name: string): Promise<unknown>;
    cancelInstall?(requestId: string): Promise<unknown>;
    waitForInstall?(requestId: string): Promise<unknown>;
    setBundleEnabled?(name: string, enabled: boolean): Promise<unknown>;
    setPluginEnabled?(entryId: string, enabled: boolean): Promise<unknown>;
    inspect?(spec: string, optionsOrSignal?: unknown, signal?: AbortSignal): Promise<unknown>;
    listBundles?(): Promise<unknown>;
    listPlugins?(): Promise<unknown>;
}
export interface OfficialManagementError {
    code?: string;
    message?: string;
    diagnostic?: string;
    incompatible?: unknown[];
    [key: string]: unknown;
}
export type OfficialApplication = 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
export type OfficialRestartReason = 'no-hmr' | 'package-moved' | 'host-module' | 'unmanaged-plugin' | 'module-comparison';
interface OfficialManagementFields {
    changed?: boolean;
    /** The change is saved but waits for restart; this does not prohibit later enablement changes. */
    restartReason?: OfficialRestartReason;
    stage?: string;
    target?: string;
    enabled?: boolean;
    error?: OfficialManagementError;
    warnings?: string[];
    pendingBuilds?: string[];
    approvedBuilds?: string[];
    bundle?: string;
    version?: string;
    registries?: Array<string | null>;
    failedAt?: string;
    packageResult?: {
        exitCode?: number;
        output?: string;
        kind?: string;
        [key: string]: unknown;
    };
    requestId?: string;
    /** A lost result could not be recovered. This must never trigger an implicit repeat installation. */
    cancelRequested?: boolean;
    cancellationStatus?: string;
    [key: string]: unknown;
}
export type OfficialManagementResult = OfficialManagementFields & ({
    indeterminate?: false;
    application?: OfficialApplication;
} | {
    indeterminate: true;
    application: 'unknown';
});
export interface OfficialInstallProgress {
    requestId: string;
    phase: 'installing' | 'cancelling' | 'applying';
    attempt?: {
        registry: string | null;
        index: number;
        total: number;
    };
}
export interface OfficialManagementEvents {
    on(event: string, callback: (payload: unknown) => void): (() => void) | void;
}
export interface OfficialCapability {
    available: boolean;
    reason?: string;
}
export interface OfficialManagementCapabilities {
    install: OfficialCapability;
    update: OfficialCapability;
    enable: OfficialCapability;
    disable: OfficialCapability;
    remove: OfficialCapability;
    cancel: OfficialCapability;
    wait: OfficialCapability;
    buildApprovals: OfficialCapability;
    registry: OfficialCapability;
    saveExact: OfficialCapability;
}
export interface OfficialInspectionOptions {
    registry?: string | null;
    signal?: AbortSignal;
}
export interface OfficialManagementAdapter {
    /** Newly installed code on these Hosts may need restart; saving enablement is still supported. */
    readonly installRequiresRestart: boolean;
    capabilities(): OfficialManagementCapabilities;
    setBundleEnabled(name: string, enabled: boolean, options?: CommandOptions): Promise<CommandResult>;
    setPluginEnabled(entryId: string, enabled: boolean, options?: CommandOptions): Promise<CommandResult>;
    inspect(spec: string, options?: OfficialInspectionOptions): Promise<unknown>;
    listBundles(): Promise<unknown>;
    listPlugins(): Promise<unknown>;
}
/** One-argument callers retain structural compatibility; added option fields require audited runtime versions. */
export declare function officialDesktopRunner(getManager: () => OfficialPluginManagerLike | undefined, runtime?: DshRuntime, events?: OfficialManagementEvents): PluginRunner;
export {};
