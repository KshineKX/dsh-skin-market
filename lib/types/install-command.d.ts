export type InstallShell = 'posix' | 'powershell' | 'cmd';
export interface InstallCommandContext {
    shell?: InstallShell;
}
/**
 * Format a DSH plugin install command for cmd.exe, PowerShell, and POSIX
 * shells. Single quotes are literal characters in cmd.exe, while double
 * quotes protect the `&path:` separator in the copied command.
 */
export declare function quoteInstallTarget(target: string): string;
export declare function createDshPluginAddCommand(target: string, profile?: string): string;
/** Copied `&path:` installs: POSIX and PowerShell profile dirs; `$DSH_HOME` is not a cmd/PowerShell variable. */
export declare function createInstallCommand(target: string, profile?: string, context?: InstallCommandContext): string;
