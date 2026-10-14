import type { DshRuntime } from './types.ts';
export declare const KEYED_SLOT_CAPABILITY_PREFIX = "slot:keyed:";
export declare const LIST_SLOT_CAPABILITY_PREFIX = "slot:list:";
export declare const LEGACY_KEYED_SETTINGS_RANGE = ">=0.1.0-rc.7 <0.1.6-alpha.2";
export declare function runtimeCapabilities(version: string | null): string[];
export declare function detectDshRuntime(): DshRuntime;
export declare function hasRuntimeCapability(runtime: DshRuntime, capability: string): boolean;
