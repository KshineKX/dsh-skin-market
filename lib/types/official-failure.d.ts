import type { CommandResult } from './commands.ts';
import type { OperationFailure } from './types.ts';
export declare function manualInstallInstruction(spec: string): string;
export declare class ManualInstallRequired extends Error {
    readonly manualSpec: string;
    constructor(spec: string, cause: string);
}
/** Classify only a confirmed Host failure. This never retries a management call. */
export declare function officialOperationFailure(result: CommandResult, canApproveBuilds?: boolean): OperationFailure | undefined;
/** Diagnostics stay in the existing sanitized log, outside user-facing text. */
export declare function officialFailureDiagnostic(result: CommandResult): string;
