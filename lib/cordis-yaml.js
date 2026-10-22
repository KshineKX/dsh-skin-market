/** Cordis evaluates this tag in DSH; the market only treats it as text. */
export const CORDIS_JS_TAG = 'tag:yaml.org,2002:js';
const cordisJsTag = {
    tag: CORDIS_JS_TAG,
    resolve: (value) => value,
};
export function cordisYamlOptions() {
    return { customTags: [cordisJsTag] };
}