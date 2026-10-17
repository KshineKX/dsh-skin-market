import type { CommandResult } from './commands.ts';
import type { CompatibilityOverride, OperationFailure } from './types.ts';
/** Only structured, unambiguous Host refusals can offer an exact-version exemption. */
export declare function officialCompatibilityOverride(result: CommandResult): CompatibilityOverride | undefined;
/** Classify only a confirmed Host failure. This never retries a management call. */
export declare function officialOperationFailure(result: CommandResult, canApproveBuilds?: boolean): OperationFailure | undefined;
/** Diagnostics stay in the existing sanitized log, outside user-facing text. */
export declare function officialFailureDiagnostic(result: CommandResult): string;
