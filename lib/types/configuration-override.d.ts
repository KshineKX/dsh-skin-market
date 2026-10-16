import type { ConfigurationOverrideBatchPlan, ConfigurationOverridePlan } from './configuration-override-types.ts';
export type { ConfigurationOverrideBatchPlan, ConfigurationOverridePlan } from './configuration-override-types.ts';
/** These locations and overlay facts must come from the running Host, never an HTTP request. */
export interface ConfigurationOverrideOptions {
    home?: string;
    patchPath?: string;
    overlays?: readonly string[];
}
export interface ConfigurationOverrideTarget {
    skinId: string;
    packageName: string;
    rowId: string;
    enabled: boolean;
}
type FailureCode = 'unavailable' | 'unsafe' | 'changed' | 'write-failed' | 'invalid-target';
export declare class ConfigurationOverrideError extends Error {
    readonly code: FailureCode;
    constructor(code: FailureCode);
}
/** Opaque receipt: original configuration bytes stay in this module, outside API responses and logs. */
export interface ConfigurationOverrideReceipt {
    readonly backupPath: string;
}
/** Returns bounded metadata only; configuration contents never leave the editor. */
export declare function inspectConfigurationOverride(options: ConfigurationOverrideOptions, target: ConfigurationOverrideTarget): ConfigurationOverridePlan;
/** Inspect every target from one source snapshot. A blocked target blocks the whole batch. */
export declare function inspectConfigurationOverrides(options: ConfigurationOverrideOptions, targets: readonly ConfigurationOverrideTarget[]): ConfigurationOverrideBatchPlan;
/** Only a fresh, explicitly approved plan may edit the one trusted home file. */
export declare function applyConfigurationOverride(options: ConfigurationOverrideOptions, target: ConfigurationOverrideTarget, context: string): {
    plan: ConfigurationOverridePlan;
    receipt: ConfigurationOverrideReceipt;
};
/** Apply all approved removals in one atomic replacement, with one backup and receipt. */
export declare function applyConfigurationOverrides(options: ConfigurationOverrideOptions, targets: readonly ConfigurationOverrideTarget[], context: string): {
    plan: ConfigurationOverrideBatchPlan;
    receipt: ConfigurationOverrideReceipt;
};
/** Refuses to overwrite any changes made after this repair. Backups remain available locally. */
export declare function rollbackConfigurationOverride(receipt: ConfigurationOverrideReceipt): void;
