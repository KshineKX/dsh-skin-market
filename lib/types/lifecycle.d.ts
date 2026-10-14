import type { PluginRunner } from './commands.ts';
import type { DesktopInstallCapability, DshRuntime, LoaderEntry, MarketHostKind, Operation, OperationKind, SkinEntry, SkinRuntimeState } from './types.ts';
export interface LifecycleHost {
    loader: {
        entries(): Iterable<LoaderEntry>;
    };
    on?(event: string, callback: (fiber: {
        entry?: {
            options?: {
                name?: string;
                id?: string;
            };
        };
    }) => void): () => void;
}
export interface LifecycleOptions {
    profile: string;
    profileDir: string;
    runner: PluginRunner;
    hostKind?: MarketHostKind;
    runtime?: DshRuntime;
    /** Shared by all preparation/install attempts; recovery has its own budget. */
    operationTimeoutMs?: number;
    recoveryTimeoutMs?: number;
    lifecycleWaitMs?: number;
}
/** Isolated temp-dir prefetches may overlap; live profile pnpm stays serial. */
export declare function maxParallelDownloads(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, memoryBytes?: number): number;
export declare function desktopInstallError(capability: DesktopInstallCapability | undefined): string;
export declare class SkinLifecycle {
    private readonly host;
    private readonly options;
    readonly operations: Map<string, Operation>;
    private profileChain;
    private profileLockOwner;
    private downloadAvailable;
    private readonly downloadWaiters;
    private readonly abortControllers;
    private readonly pendingBuildKeys;
    private readonly compatibilityContexts;
    private readonly deadlines;
    private readonly deadlineTimers;
    private readonly operationCleanupTimers;
    private readonly expired;
    private readonly profileMutations;
    private readonly recoveryErrors;
    private readonly desktopManagedAttempts;
    private readonly desktopRecoveryBaselines;
    private readonly executions;
    private catalogEntries;
    private skinById;
    private disposeEvent?;
    private disposed;
    private readonly pendingLifecycle;
    private unresolvedManager;
    get waitingReason(): string | undefined;
    constructor(host: LifecycleHost, options: LifecycleOptions, catalog?: SkinEntry[]);
    get catalog(): SkinEntry[];
    private get hostKind();
    private get management();
    private acceptManagement;
    private awaitLifecycle;
    private recordRestart;
    private registerSkin;
    private get runtime();
    private assertCompatibilityContext;
    private assertLegacyOfficialPeers;
    private applyCompatibility;
    private syncPnpmMetadata;
    private applyPendingBuildApprovals;
    private prefetchBuildApprovals;
    private preparePrefetchDirectory;
    private repairMaterializedPackage;
    replaceCatalog(catalog: SkinEntry[]): Promise<void>;
    start(): void;
    dispose(): Promise<void>;
    skin(id: string): SkinEntry;
    private entriesFor;
    private setEntryDisabled;
    private setLoaderDisabled;
    private claimManagedLoaders;
    private releaseManagedLoaders;
    private syncManagedLoaders;
    private reconcileDisabledSkinIds;
    private requiresRestartForTransition;
    replay(): Promise<void>;
    states(): SkinRuntimeState[];
    private liveOperations;
    currentOperations(): Operation[];
    currentOperation(): Operation | null;
    begin(kind: OperationKind, skinId: string, approvedBuildKeys?: readonly string[] | string, acknowledgeCompatibility?: boolean, acknowledgedContext?: string): Operation;
    retry(id: string, action: 'retry' | 'approve-build', acknowledgeCompatibility?: boolean, acknowledgedContext?: string): Operation;
    private update;
    cancel(id: string): Operation;
    private withProfileLock;
    private withDownloadSlot;
    private execute;
    private run;
    private remainingTime;
    private checkDeadline;
    private startCommand;
    /** Restore metadata first, then reconcile dependencies once within a separate budget. */
    private recoverProfile;
    private prepareProfile;
    private assertNpmMigration;
    private installPackage;
    private installCompanions;
    private claimManagedCompanion;
    private companionOwnersEnabled;
    private syncInstalledCompanions;
    private companionStillNeeded;
    private uninstallUnusedCompanions;
    private assertRuntimeLoaderConflicts;
    private prefetch;
    private install;
    private installIntoProfile;
    private selectionSnapshot;
    private rollbackSelection;
    private activate;
    private activateLocked;
    private deactivate;
    private deactivateLocked;
    private pin;
    private pinLocked;
    private unpin;
    private unpinLocked;
    private updateSkin;
    private uninstall;
    private uninstallLocked;
}
