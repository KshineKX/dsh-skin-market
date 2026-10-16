/** Public diagnostic projection. Contains no configuration contents or editable paths. */
export interface ConfigurationOverridePlan {
    status: 'repairable' | 'blocked' | 'none';
    context?: string;
    source?: 'home';
    /** Display only; the editor resolves its location from the trusted Host. */
    file?: string;
    rowId: string;
    previousDisabled?: boolean;
    desiredEnabled: boolean;
    sharedAcrossProfiles: true;
    reason: string;
}
/** One approval covers every target against the same shared-file snapshot. */
export interface ConfigurationOverrideBatchPlan {
    status: 'repairable' | 'blocked' | 'none';
    context?: string;
    changes: Array<ConfigurationOverridePlan & {
        skinId: string;
    }>;
    reason: string;
}
