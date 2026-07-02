const FIGMA_API = 'https://api.figma.com/v1';

// ─── Figma API ────────────────────────────────────────────────────────────────

function parseFileKey(url) {
  const m = url.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function parseNodeId(url) {
  const m = url.match(/node-id=([^&]+)/);
  return m ? decodeURIComponent(m[1]).replace(/-/g, ':') : null;
}

function classifyBySize(size) {
  if (size >= 96) return 'Display XL';
  if (size >= 64) return 'Display';
  if (size >= 48) return 'Heading 1';
  if (size >= 36) return 'Heading 2';
  if (size >= 28) return 'Heading 3';
  if (size >= 22) return 'Heading 4';
  if (size >= 18) return 'Body Large';
  if (size >= 15) return 'Body';
  if (size >= 12) return 'Small';
  return 'Micro';
}

async function fetchInlineStyles(fileKey, nodeId, token) {
  const headers = { 'X-Figma-Token': token };
  let rootNode;

  if (nodeId) {
    const res = await fetch(`${FIGMA_API}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`, { headers });
    if (!res.ok) throw new Error(`Failed to fetch node (${res.status})`);
    const data = await res.json();
    rootNode = data.nodes[nodeId]?.document;
    if (!rootNode) throw new Error(`Node ${nodeId} not found in file.`);
  } else {
    const res = await fetch(`${FIGMA_API}/files/${fileKey}`, { headers });
    if (!res.ok) throw new Error(`Failed to fetch file (${res.status})`);
    const data = await res.json();
    rootNode = data.document;
  }

  const buckets = new Map();
  function walk(n) {
    if (n.type === 'TEXT' && n.style?.fontSize) {
      const s = n.style;
      const key = `${s.fontFamily}|${s.fontWeight}|${Math.round(s.fontSize)}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          fontSize: s.fontSize,
          fontFamily: s.fontFamily || null,
          fontWeight: s.fontWeight || null,
          lineHeightPx: s.lineHeightPx || null,
          lineHeightUnit: s.lineHeightUnit || 'AUTO',
          letterSpacing: s.letterSpacing || 0,
          count: 0,
        });
      }
      buckets.get(key).count++;
    }
    if (n.children) n.children.forEach(walk);
  }
  walk(rootNode);

  // Sort by size desc, then weight desc
  const sorted = [...buckets.values()].sort((a, b) =>
    b.fontSize - a.fontSize || (b.fontWeight || 0) - (a.fontWeight || 0)
  );

  // Name each style — disambiguate by size/weight and family as needed
  const roleCounts = new Map();
  const sizeWeightCounts = new Map();
  sorted.forEach(s => {
    const role = classifyBySize(s.fontSize);
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    const swKey = `${role}|${Math.round(s.fontSize)}|${s.fontWeight}`;
    sizeWeightCounts.set(swKey, (sizeWeightCounts.get(swKey) || 0) + 1);
  });

  return sorted.map(s => {
    const role = classifyBySize(s.fontSize);
    const swKey = `${role}|${Math.round(s.fontSize)}|${s.fontWeight}`;
    let name = role;
    if (roleCounts.get(role) > 1) {
      name += ` · ${Math.round(s.fontSize)}/${s.fontWeight}`;
    }
    if (sizeWeightCounts.get(swKey) > 1 && s.fontFamily) {
      name += ` · ${s.fontFamily}`;
    }
    s.name = name;
    return s;
  });
}

async function fetchTextStyles(fileKey, token) {
  const headers = { 'X-Figma-Token': token };

  const stylesRes = await fetch(`${FIGMA_API}/files/${fileKey}/styles`, { headers });
  if (stylesRes.status === 403) throw new Error('Invalid token or insufficient permissions.');
  if (stylesRes.status === 404) throw new Error('File not found. Check the URL and that your token has access.');
  if (!stylesRes.ok) throw new Error(`Figma API error ${stylesRes.status}`);

  const { meta } = await stylesRes.json();
  const textStyles = (meta.styles || []).filter(s => s.style_type === 'TEXT');
  if (textStyles.length === 0) return [];

  const ids = textStyles.map(s => encodeURIComponent(s.node_id)).join(',');
  const nodesRes = await fetch(`${FIGMA_API}/files/${fileKey}/nodes?ids=${ids}`, { headers });
  if (!nodesRes.ok) throw new Error(`Failed to fetch node details (${nodesRes.status})`);
  const { nodes } = await nodesRes.json();

  return textStyles.flatMap(style => {
    const doc = nodes[style.node_id]?.document;
    const ts = doc?.style;
    if (!ts?.fontSize) return [];
    return [{
      id: style.node_id,
      name: style.name,
      fontSize: ts.fontSize,
      fontFamily: ts.fontFamily || null,
      fontWeight: ts.fontWeight || null,
      lineHeightPx: ts.lineHeightPx || null,
      lineHeightUnit: ts.lineHeightUnit || 'AUTO',
      letterSpacing: ts.letterSpacing || 0,
    }];
  });
}

// ─── Style pairing ────────────────────────────────────────────────────────────

const MOBILE_RE = /\b(mobile|sm|xs|phone|narrow|tablet)\b/i;
const DESKTOP_RE = /\b(desktop|lg|xl|wide)\b/i;

function detectBreakpoint(name) {
  if (MOBILE_RE.test(name)) return 'mobile';
  if (DESKTOP_RE.test(name)) return 'desktop';
  return null;
}

function getBaseName(name) {
  return name
    .replace(MOBILE_RE, '')
    .replace(DESKTOP_RE, '')
    .replace(/[/\\|•–—]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function pairStyles(styles) {
  const buckets = new Map();

  for (const style of styles) {
    const bp = detectBreakpoint(style.name);
    const base = bp ? getBaseName(style.name) : style.name;
    if (!buckets.has(base)) buckets.set(base, { mobile: null, desktop: null, single: null });
    const bucket = buckets.get(base);
    if (bp === 'mobile') bucket.mobile = style;
    else if (bp === 'desktop') bucket.desktop = style;
    else bucket.single = style;
  }

  return Array.from(buckets.entries()).map(([name, { mobile, desktop, single }]) => {
    if (mobile && desktop) {
      return { name, mobile, desktop, fluid: true };
    }
    const style = single || mobile || desktop;
    return { name, mobile: style, desktop: style, fluid: false };
  });
}

// ─── Type scale generation ────────────────────────────────────────────────────

function fluidClamp(mobileSize, desktopSize, minVw, maxVw, base) {
  const minRem = +(mobileSize / base).toFixed(4);
  const maxRem = +(desktopSize / base).toFixed(4);
  if (minRem === maxRem) return `${minRem}rem`;

  const slope = (desktopSize - mobileSize) / (maxVw - minVw);
  const intercept = mobileSize - slope * minVw;
  const interceptRem = intercept / base;
  const slopeVw = slope * 100;

  const fmt = n => {
    const s = Math.abs(n).toFixed(4).replace(/\.?0+$/, '') || '0';
    return s;
  };
  const sign = interceptRem >= 0 ? '+' : '-';
  return `clamp(${minRem}rem, ${fmt(slopeVw)}vw ${sign} ${fmt(interceptRem)}rem, ${maxRem}rem)`;
}

function slugify(name) {
  return name
    .replace(/\s*\+\d+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toCssVarName(name) { return '--type-' + slugify(name); }
function toClassName(name) { return 'text-' + slugify(name); }

// Serialize a font-family name as a CSS string with proper escaping.
// Prevents injection when the family contains quotes, semicolons, or newlines.
function cssFontFamily(name) { return JSON.stringify(String(name)); }

function lineHeightValue(style) {
  if (!style.lineHeightPx || style.lineHeightUnit === 'AUTO') return null;
  return +(style.lineHeightPx / style.fontSize).toFixed(3);
}

function letterSpacingValue(style) {
  if (!style.letterSpacing) return null;
  return +(style.letterSpacing / style.fontSize).toFixed(4) + 'em';
}

function generateCSS(pairs, minVw, maxVw, base) {
  const lines = [
    `/* Generated by TypeBridge */`,
    `/* Viewport range: ${minVw}px → ${maxVw}px | Base: ${base}px */`,
    ``,
    `:root {`,
  ];

  for (const p of pairs) {
    const v = toCssVarName(p.name);
    const eff = getEffectiveSizes(p);
    lines.push(`  /* ${p.name} */`);
    lines.push(`  ${v}-size: ${fluidClamp(eff.mobile, eff.desktop, minVw, maxVw, base)};`);
    if (p.mobile.fontFamily) lines.push(`  ${v}-family: ${cssFontFamily(p.mobile.fontFamily)};`);
    if (p.mobile.fontWeight) lines.push(`  ${v}-weight: ${p.mobile.fontWeight};`);
    const lh = lineHeightValue(p.mobile);
    if (lh) lines.push(`  ${v}-lh: ${lh};`);
    const ls = letterSpacingValue(p.mobile);
    if (ls) lines.push(`  ${v}-ls: ${ls};`);
    lines.push('');
  }
  lines.push(`}`);
  lines.push(``);
  lines.push(`/* Utility classes */`);

  for (const p of pairs) {
    const v = toCssVarName(p.name);
    const cls = toClassName(p.name);
    const lh = lineHeightValue(p.mobile);
    const ls = letterSpacingValue(p.mobile);
    lines.push(`.${cls} {`);
    lines.push(`  font-size: var(${v}-size);`);
    if (p.mobile.fontFamily) lines.push(`  font-family: var(${v}-family);`);
    if (p.mobile.fontWeight) lines.push(`  font-weight: var(${v}-weight);`);
    if (lh) lines.push(`  line-height: var(${v}-lh);`);
    if (ls) lines.push(`  letter-spacing: var(${v}-ls);`);
    lines.push(`}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function generateTailwind(pairs, minVw, maxVw, base) {
  const lines = [
    `// tailwind.config.js — fontSize entries`,
    `// Generated by TypeBridge | ${minVw}px → ${maxVw}px`,
    ``,
    `module.exports = {`,
    `  theme: {`,
    `    extend: {`,
    `      fontSize: {`,
  ];

  for (const p of pairs) {
    const key = slugify(p.name);
    const eff = getEffectiveSizes(p);
    const size = fluidClamp(eff.mobile, eff.desktop, minVw, maxVw, base);
    const lh = lineHeightValue(p.mobile);
    const ls = letterSpacingValue(p.mobile);
    const meta = [];
    if (lh) meta.push(`lineHeight: '${lh}'`);
    if (p.mobile.fontWeight) meta.push(`fontWeight: '${p.mobile.fontWeight}'`);
    if (ls) meta.push(`letterSpacing: '${ls}'`);

    if (meta.length > 0) {
      lines.push(`        '${key}': ['${size}', { ${meta.join(', ')} }],`);
    } else {
      lines.push(`        '${key}': '${size}',`);
    }
  }

  lines.push(`      },`);
  lines.push(`    },`);
  lines.push(`  },`);
  lines.push(`};`);

  return lines.join('\n');
}

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  pairs: [],
  minVw: 375,
  maxVw: 1440,
  base: 16,
  format: 'css',
  selectedNames: new Set(),
  source: 'published',
  // Reference viewport captured at extract time — the original "designed-at" range.
  // Effective sizes extrapolate from this reference to current min/max.
  referenceMinVw: 375,
  referenceMaxVw: 1440,
  // Semantic role mapping: { display, h1, h2, h3, body, caption, meta, _resolved }
  roleMapping: null,
};

const ROLE_ORDER = ['display', 'h1', 'h2', 'h3', 'body', 'caption', 'meta'];

function assignRoles(pairs) {
  const result = ROLE_ORDER.reduce((acc, role) => { acc[role] = null; return acc; }, {});

  if (!pairs || pairs.length === 0) {
    result._resolved = () => null;
    return result;
  }

  // Sort by effective desktop size descending — largest pair gets the most prominent role.
  const sorted = pairs.slice().sort((a, b) => {
    return getEffectiveSizes(b).desktop - getEffectiveSizes(a).desktop;
  });

  const assignCount = Math.min(sorted.length, ROLE_ORDER.length);
  for (let i = 0; i < assignCount; i++) result[ROLE_ORDER[i]] = sorted[i];

  const smallestPair = sorted[sorted.length - 1];

  result._resolved = (role) => {
    if (!ROLE_ORDER.includes(role)) return null;
    if (result[role]) return result[role];

    const idx = ROLE_ORDER.indexOf(role);
    const bodyIdx = ROLE_ORDER.indexOf('body');

    // body/caption/meta with no direct mapping → use smallest pair
    if (idx >= bodyIdx && !result.body) return smallestPair || null;

    // headings → walk up toward larger assigned roles
    for (let i = idx - 1; i >= 0; i--) if (result[ROLE_ORDER[i]]) return result[ROLE_ORDER[i]];

    // Defensive: walk down (shouldn't happen with top-down assignment)
    for (let i = idx + 1; i < ROLE_ORDER.length; i++) if (result[ROLE_ORDER[i]]) return result[ROLE_ORDER[i]];

    return null;
  };

  return result;
}

function getEffectiveSizes(pair) {
  const origMin = pair.mobile.fontSize;
  const origMax = pair.desktop.fontSize;
  if (origMin === origMax) return { mobile: origMin, desktop: origMax };

  const refMin = state.referenceMinVw;
  const refMax = state.referenceMaxVw;
  const slope = (origMax - origMin) / (refMax - refMin);

  return {
    mobile: origMin + slope * (state.minVw - refMin),
    desktop: origMin + slope * (state.maxVw - refMin),
  };
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function setLoading(loading) {
  const btn = $('connect-btn');
  btn.disabled = loading;
  btn.querySelector('.btn-label').classList.toggle('hidden', loading);
  btn.querySelector('.btn-spinner').classList.toggle('hidden', !loading);
}

function showError(msg) {
  const el = $('form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError() {
  $('form-error').classList.add('hidden');
}

function renderStyleCard(pair) {
  const card = document.createElement('div');
  card.className = 'style-card';
  card.dataset.name = pair.name;
  if (pair.fluid) card.classList.add('is-fluid');
  if (pair.manual) card.classList.add('is-manual');

  const eff = getEffectiveSizes(pair);
  const fmtPx = n => Number.isInteger(n) ? `${n}px` : `${n.toFixed(1)}px`;

  // Build DOM with textContent/setAttribute — never innerHTML with Figma-sourced strings.
  const top = document.createElement('div');
  top.className = 'style-card-top';

  const nameEl = document.createElement('span');
  nameEl.className = 'style-name';
  nameEl.textContent = pair.name;
  top.appendChild(nameEl);

  const badgeEl = document.createElement('span');
  badgeEl.className = 'badge ' + (pair.fluid ? 'badge-fluid' : 'badge-fixed');
  badgeEl.textContent = pair.fluid ? 'fluid' : 'fixed';
  top.appendChild(badgeEl);

  if (pair.manual) {
    const btn = document.createElement('button');
    btn.className = 'unpair-btn';
    btn.dataset.unpair = pair.name;
    btn.title = 'Unpair';
    btn.textContent = '✕';
    top.appendChild(btn);
  }
  card.appendChild(top);

  const sizesEl = document.createElement('div');
  sizesEl.className = 'style-sizes';
  if (pair.fluid) {
    const mob = document.createElement('span');
    mob.className = 'size-pill mobile';
    mob.textContent = fmtPx(eff.mobile);
    sizesEl.appendChild(mob);
    const arrow = document.createElement('span');
    arrow.className = 'size-arrow';
    arrow.textContent = '→';
    sizesEl.appendChild(arrow);
    const desk = document.createElement('span');
    desk.className = 'size-pill desktop';
    desk.textContent = fmtPx(eff.desktop);
    sizesEl.appendChild(desk);
  } else {
    const pill = document.createElement('span');
    pill.className = 'size-pill';
    pill.textContent = fmtPx(eff.mobile);
    sizesEl.appendChild(pill);
  }
  card.appendChild(sizesEl);

  const metaText = [
    pair.mobile.fontFamily,
    pair.mobile.fontWeight ? `w${pair.mobile.fontWeight}` : null,
  ].filter(Boolean).join(' · ');
  if (metaText) {
    const metaEl = document.createElement('div');
    metaEl.className = 'style-meta';
    metaEl.textContent = metaText;
    card.appendChild(metaEl);
  }

  return card;
}

function generateFluidGrid(minVw, maxVw, base) {
  const containerMax = '1280px';
  const paddingClamp = fluidClamp(16, 80, minVw, maxVw, base);
  const gapClamp = fluidClamp(16, 32, minVw, maxVw, base);

  return [
    '',
    '/* Fluid grid */',
    ':root {',
    `  --grid-container-max: ${containerMax};`,
    `  --grid-container-padding: ${paddingClamp};`,
    `  --grid-gap: ${gapClamp};`,
    '}',
    '',
    '.fluid-container {',
    '  max-width: var(--grid-container-max);',
    '  padding-inline: var(--grid-container-padding);',
    '  margin: 0 auto;',
    '}',
    '',
    '.fluid-grid {',
    '  display: grid;',
    '  gap: var(--grid-gap);',
    '  grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));',
    '}',
  ].join('\n');
}

function generateRoleCSS(roles) {
  if (!roles) return '';
  const lines = ['', '/* Semantic role classes */'];
  for (const role of ROLE_ORDER) {
    const pair = roles._resolved(role);
    if (!pair) continue;
    const v = toCssVarName(pair.name);
    lines.push(`.role-${role} {`);
    lines.push(`  font-size: var(${v}-size);`);
    lines.push(`  font-family: var(${v}-family, inherit);`);
    lines.push(`  font-weight: var(${v}-weight, inherit);`);
    lines.push(`  line-height: var(${v}-lh, normal);`);
    lines.push(`  letter-spacing: var(${v}-ls, normal);`);
    lines.push(`}`);
  }
  return lines.join('\n');
}

function renderOutput() {
  let code = '';
  const { pairs, minVw, maxVw, base, format } = state;

  if (format === 'css') {
    code = generateCSS(pairs, minVw, maxVw, base)
      + '\n\n' + generateFluidGrid(minVw, maxVw, base)
      + '\n' + generateRoleCSS(state.roleMapping);
  } else if (format === 'tailwind') {
    code = generateTailwind(pairs, minVw, maxVw, base);
  } else {
    code = generateCSS(pairs, minVw, maxVw, base)
      + '\n\n' + generateFluidGrid(minVw, maxVw, base)
      + '\n' + generateRoleCSS(state.roleMapping)
      + '\n\n\n' + generateTailwind(pairs, minVw, maxVw, base);
  }

  $('code-content').textContent = code;
}

// ─── Auto-pairing ─────────────────────────────────────────────────────────────

function firstSegment(name) {
  return name.split(/\s*[/·]\s*/)[0].trim();
}

function autoPair(pairs, source) {
  // Group key:
  //  - published: (firstSegment, familyBase, weight) — respects hierarchical Figma naming
  //  - inline:    (familyBase, weight) — auto-classified names already encode size buckets
  const groups = new Map();
  pairs.forEach((p, i) => {
    if (p.fluid) return;
    const family = familyBase(p.mobile.fontFamily);
    const weight = p.mobile.fontWeight;
    if (!family || !weight) return;
    const key = source === 'published'
      ? `${firstSegment(p.name)}|${family}|${weight}`
      : `${family}|${weight}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ pair: p, idx: i });
  });

  const merged = new Set();
  const newPairs = [];
  const groupOutput = new Map();

  for (const [key, items] of groups) {
    const distinctSizes = new Set(items.map(i => i.pair.mobile.fontSize));
    if (items.length < 2 || distinctSizes.size < 2) continue;

    const sorted = items.map(i => i.pair).sort((a, b) => a.mobile.fontSize - b.mobile.fontSize);
    const smaller = sorted[0];
    const larger = sorted[sorted.length - 1];

    const newPair = {
      name: pairName(sorted),
      mobile: smaller.mobile,
      desktop: larger.mobile,
      fluid: true,
      manual: true,
      pairedFrom: sorted.map(p => ({ name: p.name, style: p.mobile })),
    };

    const minIdx = Math.min(...items.map(i => i.idx));
    items.forEach(i => merged.add(i.pair.name));
    groupOutput.set(minIdx, newPair);
  }

  pairs.forEach((p, i) => {
    if (groupOutput.has(i)) newPairs.push(groupOutput.get(i));
    if (!merged.has(p.name)) newPairs.push(p);
  });

  return newPairs;
}

// ─── Manual pairing ───────────────────────────────────────────────────────────

const WEIGHT_NAMES = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

function familyBase(family) {
  if (!family) return '';
  let base = family;
  let prev;
  do {
    prev = base;
    base = base.replace(/\s+(Standard|Std|Pro|Regular|Book|VAR|Variable)$/i, '').trim();
  } while (base !== prev);
  return base;
}

function handleCardClick(name, selectFamily = false) {
  const pair = state.pairs.find(p => p.name === name);
  if (!pair || pair.fluid) return;

  if (selectFamily) {
    const base = familyBase(pair.mobile.fontFamily);
    const weight = pair.mobile.fontWeight;
    const matching = state.pairs.filter(p =>
      !p.fluid &&
      familyBase(p.mobile.fontFamily) === base &&
      p.mobile.fontWeight === weight
    );
    const allSelected = matching.every(p => state.selectedNames.has(p.name));
    matching.forEach(p => {
      if (allSelected) state.selectedNames.delete(p.name);
      else state.selectedNames.add(p.name);
    });
  } else {
    if (state.selectedNames.has(name)) {
      state.selectedNames.delete(name);
    } else {
      state.selectedNames.add(name);
    }
  }
  updateSelectionUI();
}

function pairName(items) {
  const sorted = [...items].sort((a, b) => a.mobile.fontSize - b.mobile.fontSize);
  const smaller = sorted[0];
  const larger = sorted[sorted.length - 1];

  // If all items share the same first-segment of their name AND weight,
  // that's a clear scale group (e.g. "Heading H1–H5") — use the segment.
  const segments = new Set(items.map(i => firstSegment(i.name)));
  const weights = new Set(items.map(i => i.mobile.fontWeight));
  const weightName = WEIGHT_NAMES[[...weights][0]] || null;
  if (segments.size === 1 && weights.size === 1) {
    const segment = [...segments][0];
    if (segment) return weightName ? `${segment} ${weightName}` : segment;
  }

  // Else if all share font family base AND weight, use the family name.
  const families = new Set(items.map(i => familyBase(i.mobile.fontFamily)));
  if (families.size === 1 && weights.size === 1) {
    const family = [...families][0];
    if (family) return weightName ? `${family} ${weightName}` : family;
  }

  const stripNoise = name => name
    .replace(/\s·\s\d+\/\d+\s·\s[^·]+$/, '')
    .replace(/\s·\s\d+\/\d+$/, '')
    .trim();

  const sName = stripNoise(smaller.name);
  const lName = stripNoise(larger.name);
  const extra = items.length > 2 ? ` +${items.length - 2}` : '';

  if (sName === lName) return `${sName} scale${extra}`;

  let i = 0;
  while (i < sName.length && i < lName.length && sName[i] === lName[i]) i++;
  const m = sName.slice(0, i).match(/^(.+[/\s·\-])/);
  if (m && m[1].replace(/[/\s·\-]+$/, '').trim().length >= 3) {
    const prefixLen = m[1].length;
    const cleanPrefix = m[1].replace(/[/\s·\-]+$/, '').trim();
    return `${cleanPrefix} ${sName.slice(prefixLen).trim()} ⇄ ${lName.slice(prefixLen).trim()}${extra}`;
  }

  return `${sName} ⇄ ${lName}${extra}`;
}

function pairSelected() {
  const items = [...state.selectedNames]
    .map(n => state.pairs.find(p => p.name === n))
    .filter(Boolean);
  if (items.length < 2) return;

  items.sort((a, b) => a.mobile.fontSize - b.mobile.fontSize);
  const smaller = items[0];
  const larger = items[items.length - 1];

  const newPair = {
    name: pairName(items),
    mobile: smaller.mobile,
    desktop: larger.mobile,
    fluid: true,
    manual: true,
    pairedFrom: items.map(p => ({ name: p.name, style: p.mobile })),
  };

  const selectedSet = new Set(items.map(i => i.name));
  const minIdx = Math.min(...items.map(i => state.pairs.findIndex(p => p.name === i.name)));

  state.pairs = state.pairs.filter(p => !selectedSet.has(p.name));
  state.pairs.splice(minIdx, 0, newPair);
  state.selectedNames.clear();
  renderResults(state.pairs);
}

function clearSelection() {
  state.selectedNames.clear();
  updateSelectionUI();
}

function lockAsReference() {
  state.pairs.forEach(pair => {
    if (!pair.fluid) return;
    const eff = getEffectiveSizes(pair);
    pair.mobile = { ...pair.mobile, fontSize: +eff.mobile.toFixed(2) };
    pair.desktop = { ...pair.desktop, fontSize: +eff.desktop.toFixed(2) };
  });
  state.referenceMinVw = state.minVw;
  state.referenceMaxVw = state.maxVw;
  renderResults(state.pairs, { scroll: false });
  updateLockButton();
}

function updateLockButton() {
  const btn = $('lock-reference-btn');
  if (!btn) return;
  const hasChange = state.pairs.length > 0
    && (state.minVw !== state.referenceMinVw || state.maxVw !== state.referenceMaxVw);
  btn.disabled = !hasChange;
}

function unpairManual(name) {
  const idx = state.pairs.findIndex(p => p.name === name);
  if (idx === -1) return;
  const pair = state.pairs[idx];
  if (!pair.manual || !pair.pairedFrom) return;

  const restored = pair.pairedFrom.map(p => ({
    name: p.name,
    mobile: p.style,
    desktop: p.style,
    fluid: false,
  }));

  state.pairs.splice(idx, 1, ...restored);
  renderResults(state.pairs);
}

function updateSelectionUI() {
  const count = state.selectedNames.size;

  document.querySelectorAll('.style-card').forEach(card => {
    const name = card.dataset.name;
    card.classList.toggle('selected', state.selectedNames.has(name));
    card.classList.toggle('pairable', count > 0 && !state.selectedNames.has(name) && !card.classList.contains('is-fluid'));
  });

  const bar = $('selection-bar');
  const subtitle = $('detected-subtitle');

  if (count >= 2) {
    bar?.classList.remove('hidden');
    $('selection-count').textContent = `${count} styles selected`;
    if (subtitle) subtitle.classList.add('hidden');
  } else {
    bar?.classList.add('hidden');
    if (subtitle) {
      subtitle.classList.remove('hidden');
      subtitle.innerHTML = count === 1
        ? `<strong>1 style selected.</strong> Click more <strong>fixed</strong> styles — or <kbd>⌥</kbd>+click to add the whole family/weight — then pair.`
        : `Click <strong>fixed</strong> styles to select them. <kbd>⌥</kbd>+click to select all matching family/weight. Pair 2+ into a fluid <code>clamp()</code>.`;
    }
  }
}

function renderResults(pairs, { scroll = true } = {}) {
  state.pairs = pairs;
  state.roleMapping = assignRoles(pairs);

  // Source banner
  const banner = $('source-banner');
  if (state.source === 'inline-node') {
    banner.innerHTML = `No published text styles found. <strong>Auto-extracted from inline text</strong> in the linked node. Names are inferred from size.`;
    banner.classList.remove('hidden');
  } else if (state.source === 'inline-file') {
    banner.innerHTML = `No published text styles found. <strong>Auto-extracted from inline text</strong> across the whole file. Names are inferred from size.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  const fluid = pairs.filter(p => p.fluid).length;
  const fixed = pairs.filter(p => !p.fluid).length;

  $('stat-total').textContent = pairs.length;
  $('stat-paired').textContent = fluid;
  $('stat-unpaired').textContent = fixed;

  const grid = $('styles-grid');
  grid.innerHTML = '';
  pairs.forEach(p => grid.appendChild(renderStyleCard(p)));
  updateSelectionUI();

  renderOutput();
  renderPreview(pairs);
  refreshLayoutShowcase();
  updateLayoutCanvas(state.minVw);
  updateLockButton();
  $('results').classList.remove('hidden');
  if (scroll) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Preview panel ────────────────────────────────────────────────────────────

const BREAKPOINTS = [375, 768, 1024, 1440];

// Build the inner content for a breakpoint tick — uses textContent for the label so
// the safety invariant is local (not dependent on the caller passing a Number).
function buildTickInner(bp) {
  const frag = document.createDocumentFragment();
  const line = document.createElement('div');
  line.className = 'bp-tick-line';
  frag.appendChild(line);
  const label = document.createElement('span');
  label.className = 'bp-tick-label';
  label.textContent = String(bp);
  frag.appendChild(label);
  return frag;
}

const DEVICE_CONFIG = [
  { maxVw: 767,  icon: '📱', name: 'Mobile' },
  { maxVw: 1023, icon: '💻', name: 'Tablet' },
  { maxVw: Infinity, icon: '🖥', name: 'Desktop' },
];

function sampleText(name, fontSize) {
  const n = name.toLowerCase();
  if (n.includes('display') || fontSize >= 56) return 'The future of design is fluid';
  if (n.match(/\bh1\b|heading.?1/) || fontSize >= 40) return 'Typography at Scale';
  if (n.match(/\bh2\b|heading.?2/) || fontSize >= 28) return 'Building design systems';
  if (n.match(/\bh3\b|heading.?3|h4|heading.?4/) || fontSize >= 20) return 'Type scale across breakpoints';
  if (n.match(/body|paragraph|text/) || fontSize >= 14) return 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.';
  return 'Caption · Supporting text · UI label';
}

function interpolateSize(mobileSize, desktopSize, vw, minVw, maxVw) {
  if (vw <= minVw) return mobileSize;
  if (vw >= maxVw) return desktopSize;
  const t = (vw - minVw) / (maxVw - minVw);
  return mobileSize + (desktopSize - mobileSize) * t;
}

// ─── Layout Showcase ──────────────────────────────────────────────────────────

function refreshLayoutShowcase() {
  // Inject role-class CSS (maps .role-display etc. → the assigned pair's --type-* vars)
  let styleEl = document.getElementById('role-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'role-styles';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = generateRoleCSS(state.roleMapping);

  // Sync the layout-scrub slider's range with current state, and rebuild ticks
  const scrub = document.getElementById('layout-scrub-slider');
  if (scrub) {
    scrub.min = state.minVw;
    scrub.max = state.maxVw;
    scrub.value = state.minVw;
    scrub.style.setProperty('--progress', `0%`);
  }
  const ticksEl = document.getElementById('layout-scrub-ticks');
  if (ticksEl) {
    ticksEl.innerHTML = '';
    const range = state.maxVw - state.minVw;
    const tickSet = new Set([state.minVw, state.maxVw]);
    const minGap = range * 0.05;
    BREAKPOINTS.forEach(bp => {
      if (bp > state.minVw + minGap && bp < state.maxVw - minGap) tickSet.add(bp);
    });
    const tickValues = [...tickSet].sort((a, b) => a - b);
    tickValues.forEach((bp, i) => {
      const pct = ((bp - state.minVw) / range) * 100;
      const tick = document.createElement('div');
      tick.className = 'bp-tick';
      if (i === 0) tick.classList.add('is-first');
      if (i === tickValues.length - 1) tick.classList.add('is-last');
      tick.style.left = `${pct}%`;
      tick.appendChild(buildTickInner(bp));
      ticksEl.appendChild(tick);
    });
  }
}

function updateLayoutCanvas(vw) {
  const canvas = document.getElementById('layout-canvas');
  if (!canvas) return;

  // Simulate viewport width on the canvas itself.
  canvas.style.width = `${vw}px`;

  // Grow the card laterally so it can contain the canvas without internal scroll.
  // The card breaks out of .main via negative margins controlled by --card-breakout.
  const card = document.querySelector('.layout-showcase-card');
  const main = document.querySelector('.main');
  if (card && main) {
    const mainContentWidth = main.clientWidth - 48; // .main padding 24px each side
    const desiredCardWidth = vw + 32; // small padding around canvas
    if (desiredCardWidth > mainContentWidth) {
      card.style.setProperty('--card-breakout', `${(desiredCardWidth - mainContentWidth) / 2}px`);
    } else {
      card.style.setProperty('--card-breakout', '0px');
    }
  }

  // Sync the layout-scrub slider position. Always refresh --progress, even when
  // the user already moved the thumb natively (value === vw) — the custom track
  // fill is driven by the var, not the thumb.
  const scrub = document.getElementById('layout-scrub-slider');
  if (scrub) {
    if (parseInt(scrub.value) !== vw) scrub.value = vw;
    const progress = ((vw - state.minVw) / (state.maxVw - state.minVw)) * 100;
    scrub.style.setProperty('--progress', `${progress}%`);
  }

  // Badge
  const badge = document.getElementById('layout-vw');
  if (badge) badge.textContent = Math.round(vw);

  if (!state.roleMapping) return;

  // For every pair that's actually referenced by some role, override its --type-*-size
  // (and family / weight / lh / ls vars) on the canvas with the interpolated value at vw.
  // Without this override, the global clamp() would resolve against the document viewport,
  // not the simulated one — defeating the slider.
  const usedPairs = new Map(); // slug → pair
  for (const role of ROLE_ORDER) {
    const pair = state.roleMapping._resolved(role);
    if (pair) usedPairs.set(slugify(pair.name), pair);
  }

  for (const [slug, pair] of usedPairs) {
    const eff = getEffectiveSizes(pair);
    const size = interpolateSize(eff.mobile, eff.desktop, vw, state.minVw, state.maxVw);
    canvas.style.setProperty(`--type-${slug}-size`, `${size}px`);
    if (pair.mobile.fontFamily) canvas.style.setProperty(`--type-${slug}-family`, cssFontFamily(pair.mobile.fontFamily));
    if (pair.mobile.fontWeight) canvas.style.setProperty(`--type-${slug}-weight`, pair.mobile.fontWeight);
    const lh = lineHeightValue(pair.mobile);
    if (lh != null) canvas.style.setProperty(`--type-${slug}-lh`, lh);
    const ls = letterSpacingValue(pair.mobile);
    if (ls != null) canvas.style.setProperty(`--type-${slug}-ls`, ls);
  }

  // Fluid-grid tokens — interpolate at the simulated viewport (not the document one).
  const padding = interpolateSize(16, 80, vw, state.minVw, state.maxVw);
  const gap = interpolateSize(16, 32, vw, state.minVw, state.maxVw);
  canvas.style.setProperty('--grid-container-padding', `${padding}px`);
  canvas.style.setProperty('--grid-gap', `${gap}px`);
}

function renderPreview(pairs) {
  const slider = $('viewport-slider');
  slider.min = state.minVw;
  slider.max = state.maxVw;
  slider.value = state.minVw;

  // Breakpoint tick marks — always include current min/max + standard breakpoints in between
  const ticksEl = $('breakpoint-ticks');
  ticksEl.innerHTML = '';
  const range = state.maxVw - state.minVw;
  const tickSet = new Set([state.minVw, state.maxVw]);
  const minGap = range * 0.05;
  BREAKPOINTS.forEach(bp => {
    if (bp > state.minVw + minGap && bp < state.maxVw - minGap) tickSet.add(bp);
  });
  const tickValues = [...tickSet].sort((a, b) => a - b);
  tickValues.forEach((bp, i) => {
    const pct = ((bp - state.minVw) / range) * 100;
    const tick = document.createElement('div');
    tick.className = 'bp-tick';
    if (i === 0) tick.classList.add('is-first');
    if (i === tickValues.length - 1) tick.classList.add('is-last');
    tick.style.left = `${pct}%`;
    tick.appendChild(buildTickInner(bp));
    ticksEl.appendChild(tick);
  });

  // Build specimen rows — no innerHTML with Figma-sourced strings.
  const specimensEl = $('preview-specimens');
  specimensEl.innerHTML = '';
  pairs.forEach(pair => {
    const slug = slugify(pair.name);
    const row = document.createElement('div');
    row.className = 'specimen';
    row.dataset.name = pair.name;
    row.dataset.pairSlug = slug;

    const baseSize = getEffectiveSizes(pair).mobile;
    const text = sampleText(pair.name, baseSize);
    const fw = pair.mobile.fontWeight || 400;
    const lh = pair.mobile.lineHeightPx
      ? (pair.mobile.lineHeightPx / pair.mobile.fontSize).toFixed(2)
      : 1.2;

    const metaEl = document.createElement('div');
    metaEl.className = 'specimen-meta';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'specimen-name';
    nameSpan.textContent = pair.name;
    metaEl.appendChild(nameSpan);

    const computedSpan = document.createElement('span');
    computedSpan.className = 'specimen-computed';
    computedSpan.dataset.role = 'computed';
    computedSpan.textContent = '—';
    metaEl.appendChild(computedSpan);

    row.appendChild(metaEl);

    const textEl = document.createElement('div');
    textEl.className = 'specimen-text';
    textEl.dataset.role = 'text';
    // Set font-family via DOM property, not inline style string — avoids CSS injection.
    textEl.style.fontFamily = pair.mobile.fontFamily
      ? `${cssFontFamily(pair.mobile.fontFamily)}, system-ui, sans-serif`
      : 'system-ui, sans-serif';
    textEl.style.fontWeight = String(fw);
    textEl.style.lineHeight = String(lh);
    textEl.textContent = text;
    row.appendChild(textEl);

    specimensEl.appendChild(row);
  });

  updatePreviewSizes(state.minVw);
}

function updatePreviewSizes(vw) {
  const range = state.maxVw - state.minVw;
  const progress = Math.round(((vw - state.minVw) / range) * 100);

  // Slider fill
  $('viewport-slider').style.setProperty('--progress', `${progress}%`);

  // Readout
  $('viewport-label').textContent = `${vw}px`;
  const device = DEVICE_CONFIG.find(d => vw <= d.maxVw);
  $('device-icon').textContent = device.icon;
  $('device-name').textContent = device.name;

  // Specimens — look up via CSS.escape on the slug (safe even if pair.name contains quotes/dots/slashes).
  const specimensEl = $('preview-specimens');
  state.pairs.forEach(pair => {
    const eff = getEffectiveSizes(pair);
    const computed = interpolateSize(eff.mobile, eff.desktop, vw, state.minVw, state.maxVw);
    const px = computed.toFixed(1);
    const rem = +(computed / state.base).toFixed(3);
    const pct = +(computed / state.base * 100).toFixed(1);
    const slug = slugify(pair.name);

    const row = specimensEl.querySelector(`[data-pair-slug="${CSS.escape(slug)}"]`);
    if (!row) return;
    const textEl = row.querySelector('[data-role="text"]');
    const computedEl = row.querySelector('[data-role="computed"]');

    if (textEl) textEl.style.fontSize = `${px}px`;
    if (computedEl) {
      computedEl.textContent = '';
      const pxSpan = document.createElement('span');
      pxSpan.className = 'unit-px';
      pxSpan.textContent = `${px}px`;
      const subSpan = document.createElement('span');
      subSpan.className = 'unit-sub';
      subSpan.textContent = `${rem}rem · ${pct}%`;
      computedEl.appendChild(pxSpan);
      computedEl.appendChild(subSpan);
    }
  });
}

// ─── Event handlers ───────────────────────────────────────────────────────────

$('connect-form').addEventListener('submit', async e => {
  e.preventDefault();
  clearError();

  const url = $('figma-url').value.trim();
  const token = $('api-token').value.trim();

  if (!url) { showError('Please enter a Figma file URL.'); return; }
  if (!token) { showError('Please enter your Figma personal access token.'); return; }

  const fileKey = parseFileKey(url);
  if (!fileKey) { showError('Could not parse file key from URL. Make sure it is a Figma file or design URL.'); return; }

  sessionStorage.setItem('figma-token', token);

  setLoading(true);
  try {
    let styles = await fetchTextStyles(fileKey, token);
    let source = 'published';

    if (styles.length === 0) {
      const nodeId = parseNodeId(url);
      styles = await fetchInlineStyles(fileKey, nodeId, token);
      if (styles.length === 0) {
        showError('No text styles found — neither published styles nor inline text.');
        return;
      }
      source = nodeId ? 'inline-node' : 'inline-file';
    }

    state.source = source;
    state.referenceMinVw = state.minVw;
    state.referenceMaxVw = state.maxVw;
    const basePairs = source === 'published'
      ? pairStyles(styles)
      : styles.map(s => ({ name: s.name, mobile: s, desktop: s, fluid: false }));
    const pairs = autoPair(basePairs, source);
    renderResults(pairs);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

$('reset-btn').addEventListener('click', () => {
  $('results').classList.add('hidden');
  $('connect-section').scrollIntoView({ behavior: 'smooth' });
});

// Selection bar buttons
$('pair-selected-btn').addEventListener('click', pairSelected);
$('clear-selection-btn').addEventListener('click', clearSelection);

// Lock-as-reference button
$('lock-reference-btn').addEventListener('click', lockAsReference);

// Style card click delegation (manual pairing)
$('styles-grid').addEventListener('click', e => {
  const unpairBtn = e.target.closest('.unpair-btn');
  if (unpairBtn) {
    e.stopPropagation();
    unpairManual(unpairBtn.dataset.unpair);
    return;
  }
  const card = e.target.closest('.style-card');
  if (card) handleCardClick(card.dataset.name, e.altKey || e.metaKey);
});

// Restore saved token
const saved = sessionStorage.getItem('figma-token');
if (saved) $('api-token').value = saved;

// Main viewport slider (lives in Type Preview)
$('viewport-slider').addEventListener('input', e => {
  const vw = parseInt(e.target.value);
  updatePreviewSizes(vw);
  updateLayoutCanvas(vw);
});

// Layout-local scrub slider — mirrors the main slider in both directions
$('layout-scrub-slider').addEventListener('input', e => {
  const vw = parseInt(e.target.value);
  const main = $('viewport-slider');
  if (parseInt(main.value) !== vw) {
    main.value = vw;
    main.dispatchEvent(new Event('input'));
  }
});

// Layout canvas resize-handle: drag the right edge to scrub the simulated viewport.
// Pushes the new width into the slider, which then drives everything else.
(() => {
  const handle = $('layout-resize-handle');
  if (!handle) return;
  const canvas = $('layout-canvas');
  const slider = $('viewport-slider');
  let drag = null;

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-dragging');
    canvas.classList.add('is-resizing');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    drag = { startX: e.clientX, startWidth: canvas.offsetWidth };
  });

  handle.addEventListener('pointermove', e => {
    if (!drag) return;
    const next = Math.round(drag.startWidth + (e.clientX - drag.startX));
    const clamped = Math.max(state.minVw, Math.min(state.maxVw, next));
    slider.value = clamped;
    slider.dispatchEvent(new Event('input'));
  });

  const end = () => {
    if (!drag) return;
    drag = null;
    handle.classList.remove('is-dragging');
    canvas.classList.remove('is-resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
})();

// Viewport / base font changes
['min-vw', 'max-vw', 'base-font'].forEach(id => {
  $(id).addEventListener('input', () => {
    const minVw = parseInt($('min-vw').value) || 375;
    const maxVw = parseInt($('max-vw').value) || 1440;
    const base = parseInt($('base-font').value) || 16;
    if (minVw >= maxVw) return;
    state.minVw = minVw;
    state.maxVw = maxVw;
    state.base = base;
    if (state.pairs.length) {
      renderResults(state.pairs, { scroll: false });
    }
    updateLockButton();
  });
});

// Format tabs
document.querySelectorAll('.format-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.format-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.format = tab.dataset.format;
    if (state.pairs.length) renderOutput();
  });
});

// Copy button
$('copy-btn').addEventListener('click', async () => {
  const text = $('code-content').textContent;
  await navigator.clipboard.writeText(text);
  const btn = $('copy-btn');
  btn.classList.add('copied');
  btn.querySelector('svg').style.display = 'none';
  btn.lastChild.textContent = ' Copied!';
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.querySelector('svg').style.display = '';
    btn.lastChild.textContent = ' Copy';
  }, 2000);
});
