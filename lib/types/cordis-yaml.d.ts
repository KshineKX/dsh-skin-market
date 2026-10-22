import type { ScalarTag } from 'yaml';
/** Cordis evaluates this tag in DSH; the market only treats it as text. */
export declare const CORDIS_JS_TAG = "tag:yaml.org,2002:js";
export declare function cordisYamlOptions(): {
    customTags: ScalarTag[];
};
