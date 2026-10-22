import type { ScalarTag } from 'yaml'

/** Cordis evaluates this tag in DSH; the market only treats it as text. */
export const CORDIS_JS_TAG = 'tag:yaml.org,2002:js'

const cordisJsTag: ScalarTag = {
  tag: CORDIS_JS_TAG,
  resolve: value => value,
}

export function cordisYamlOptions(): { customTags: ScalarTag[] } {
  return { customTags: [cordisJsTag] }
}
