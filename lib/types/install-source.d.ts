/** Shared by the host, embedded market, and public site. Keep browser-safe. */
export interface InstallSourceSkin {
    install: {
        target: string;
        npm?: {
            name: string;
            version: string;
        };
    };
}
export declare function npmInstallTarget(skin: InstallSourceSkin): string | null;
export declare function preferredInstallTarget(skin: InstallSourceSkin): string;
/** Manual copy fields follow the npm default tag; managed operations stay pinned. */
export declare function manualInstallTarget(skin: InstallSourceSkin): string;
export declare function unversionedNpmTarget(target: string): string;
