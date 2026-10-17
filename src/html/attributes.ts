/**
 * HTML attributes as React props, for the `html` tags `htmlTags` produces.
 * The name mapping follows React's HTMLDOMPropertyConfig.
 */

// HTML attribute -> React prop names.
const ATTRIBUTE_MAPPING: Record<string, string> = {
  for: 'htmlFor',
  class: 'className',
  'accept-charset': 'acceptCharset',
  accesskey: 'accessKey',
  allowfullscreen: 'allowFullScreen',
  allowtransparency: 'allowTransparency',
  autocomplete: 'autoComplete',
  autoplay: 'autoPlay',
  cellpadding: 'cellPadding',
  cellspacing: 'cellSpacing',
  charset: 'charSet',
  classid: 'classID',
  colspan: 'colSpan',
  contenteditable: 'contentEditable',
  contextmenu: 'contextMenu',
  crossorigin: 'crossOrigin',
  datetime: 'dateTime',
  enctype: 'encType',
  formaction: 'formAction',
  formenctype: 'formEncType',
  formmethod: 'formMethod',
  formnovalidate: 'formNoValidate',
  formtarget: 'formTarget',
  frameborder: 'frameBorder',
  hreflang: 'hrefLang',
  'http-equiv': 'httpEquiv',
  inputmode: 'inputMode',
  keyparams: 'keyParams',
  keytype: 'keyType',
  marginheight: 'marginHeight',
  marginwidth: 'marginWidth',
  maxlength: 'maxLength',
  mediagroup: 'mediaGroup',
  minlength: 'minLength',
  novalidate: 'noValidate',
  playsinline: 'playsInline',
  radiogroup: 'radioGroup',
  readonly: 'readOnly',
  referrerpolicy: 'referrerPolicy',
  rowspan: 'rowSpan',
  spellcheck: 'spellCheck',
  srcdoc: 'srcDoc',
  srclang: 'srcLang',
  srcset: 'srcSet',
  tabindex: 'tabIndex',
  usemap: 'useMap',
  autocapitalize: 'autoCapitalize',
  autocorrect: 'autoCorrect',
  autosave: 'autoSave',
  itemprop: 'itemProp',
  itemscope: 'itemScope',
  itemtype: 'itemType',
  itemid: 'itemID',
  itemref: 'itemRef',
  'accent-height': 'accentHeight',
  'alignment-baseline': 'alignmentBaseline',
  'arabic-form': 'arabicForm',
  'baseline-shift': 'baselineShift',
  'cap-height': 'capHeight',
  'clip-path': 'clipPath',
  'clip-rule': 'clipRule',
  'color-interpolation': 'colorInterpolation',
  'color-interpolation-filters': 'colorInterpolationFilters',
  'color-profile': 'colorProfile',
  'color-rendering': 'colorRendering',
  'dominant-baseline': 'dominantBaseline',
  'enable-background': 'enableBackground',
  'fill-opacity': 'fillOpacity',
  'fill-rule': 'fillRule',
  'flood-color': 'floodColor',
  'flood-opacity': 'floodOpacity',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-size-adjust': 'fontSizeAdjust',
  'font-stretch': 'fontStretch',
  'font-style': 'fontStyle',
  'font-variant': 'fontVariant',
  'font-weight': 'fontWeight',
  'glyph-name': 'glyphName',
  'glyph-orientation-horizontal': 'glyphOrientationHorizontal',
  'glyph-orientation-vertical': 'glyphOrientationVertical',
  'horiz-adv-x': 'horizAdvX',
  'horiz-origin-x': 'horizOriginX',
  'image-rendering': 'imageRendering',
  'letter-spacing': 'letterSpacing',
  'lighting-color': 'lightingColor',
  'marker-end': 'markerEnd',
  'marker-mid': 'markerMid',
  'marker-start': 'markerStart',
  'overline-position': 'overlinePosition',
  'overline-thickness': 'overlineThickness',
  'paint-order': 'paintOrder',
  'panose-1': 'panose1',
  'pointer-events': 'pointerEvents',
  'rendering-intent': 'renderingIntent',
  'shape-rendering': 'shapeRendering',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'strikethrough-position': 'strikethroughPosition',
  'strikethrough-thickness': 'strikethroughThickness',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity',
  'stroke-width': 'strokeWidth',
  'text-anchor': 'textAnchor',
  'text-decoration': 'textDecoration',
  'text-rendering': 'textRendering',
  'underline-position': 'underlinePosition',
  'underline-thickness': 'underlineThickness',
  'unicode-bidi': 'unicodeBidi',
  'unicode-range': 'unicodeRange',
  'units-per-em': 'unitsPerEm',
  'v-alphabetic': 'vAlphabetic',
  'v-hanging': 'vHanging',
  'v-ideographic': 'vIdeographic',
  'v-mathematical': 'vMathematical',
  'vector-effect': 'vectorEffect',
  'vert-adv-y': 'vertAdvY',
  'vert-origin-x': 'vertOriginX',
  'vert-origin-y': 'vertOriginY',
  'word-spacing': 'wordSpacing',
  'writing-mode': 'writingMode',
  'x-height': 'xHeight',
  'xlink:actuate': 'xlinkActuate',
  'xlink:arcrole': 'xlinkArcrole',
  'xlink:href': 'xlinkHref',
  'xlink:role': 'xlinkRole',
  'xlink:show': 'xlinkShow',
  'xlink:title': 'xlinkTitle',
  'xlink:type': 'xlinkType',
  'xml:base': 'xmlBase',
  'xmlns:xlink': 'xmlnsXlink',
  'xml:lang': 'xmlLang',
  'xml:space': 'xmlSpace',
};

/** Convert raw HTML attributes to React props (names, style objects, controlled-input defaults). */
export function getJsxConvertedAttributes(
  attrs: Record<string, string>,
  tagName?: string
): Record<string, string | boolean | object> {
  const result: Record<string, string | boolean | object> = {};
  for (const [name, value] of Object.entries(attrs)) {
    switch (name) {
      case 'value':
        if (tagName === 'input' || tagName === 'textarea') {
          result.defaultValue = value;
        } else {
          result.value = value;
        }
        break;
      case 'checked':
        if (tagName === 'input') {
          result.defaultChecked = true;
        } else {
          result.checked = value;
        }
        break;
      case 'style':
        result.style = convertStyleAttrs(value);
        break;
      default:
        result[ATTRIBUTE_MAPPING[name] || name] = value;
    }
  }
  return result;
}

function replaceStyleName(styleName: string): string {
  if (styleName.match(/^--/)) {
    return styleName;
  }
  return styleName.replace(/-[a-z]/g, (match) => match[1].toUpperCase());
}

function convertStyleAttrs(input: string): Record<string, string> {
  return input
    .split(';')
    .filter((style) => style.trim().length)
    .reduce((styleObj: Record<string, string>, style) => {
      const [key, value = ''] = style.split(':');
      styleObj[replaceStyleName(key.trim())] = value.trim();
      return styleObj;
    }, {});
}
