export declare const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
/** Normalize a registry base without preserving credentials or query data. */
export declare function normalizeRegistryBase(value: unknown): string | null;
/** Keep the host-provided order while removing invalid and duplicate entries. */
export declare function normalizeRegistryPlan(values: readonly unknown[] | undefined): string[] | undefined;
/** Convert the official plugin manager snapshot into a safe ordered plan. */
export declare function registryPlanFromSnapshot(value: unknown): string[] | undefined;
export type RegistryPlanProvider = () => Promise<readonly string[] | undefined>;
