/**
 * Regression guard for the Auto-mode per-block direction walker
 * (Codex round-1 P2, PR #2): the walker must only tag blocks inside
 * markdown containers, and its skip selector must cover every container
 * the LTR overrides protect — a native dir attribute on a child is not
 * neutralized by direction rules on its container.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.ts'), 'utf8');

const walker = src.match(/\/\* Per-Block Direction[\s\S]*?\n\}\)\(\);/);
if (!walker) {
    console.error('FAIL — per-block direction walker not found in content.ts');
    process.exit(1);
}
const w = walker[0];

const failures = [];

// 1. Walker must query blocks from markdown roots, never bubble-wide.
if (!/querySelectorAll\('\[class\*="root_"\]'\)/.test(w)) {
    failures.push('walker no longer scopes its block query under [class*="root_"] markdown containers');
}

// 2. Skip selector must include every protected container class.
const skipSel = (w.match(/var SKIP_SEL = '([^']+)'/) || [])[1] || '';
for (const cls of [
    'codeBlockWrapper_', 'thinkingContent_', 'thinking_',
    'toolUse_', 'toolSummary_', 'toolBody_', 'toolResult_', 'toolReference_',
    'todoList_', 'todoListContainer_',
]) {
    if (!skipSel.includes(cls)) failures.push(`SKIP_SEL is missing protected container "${cls}"`);
}
for (const tag of ['pre', 'code']) {
    if (!new RegExp(`(^|,)${tag}(,|$)`).test(skipSel)) failures.push(`SKIP_SEL is missing "${tag}"`);
}

// 3. CSS dir rules must keep the thinking-block guard (Copilot round-2, PR #2):
//    per-block [dir] styling must never apply under thinkingContent_.
for (const dir of ['rtl', 'ltr']) {
    const re = new RegExp(
        `\\[class\\*="root_"\\]:not\\(\\[class\\*="thinkingContent_"\\] \\[class\\*="root_"\\]\\) :is\\([^)]*\\)\\[dir="${dir}"\\]`
    );
    if (!re.test(src)) {
        failures.push(`CSS [dir="${dir}"] block rule lost its thinkingContent_ guard`);
    }
}

// 4. Anchors need their own inline bidi run (Codex round-3 P2, PR #2):
//    unicode-bidi is not inherited, so block-level isolation alone leaves
//    URL punctuation reorderable by the surrounding RTL context.
if (!/\[class\*="root_"\]:not\(\[class\*="thinkingContent_"\] \[class\*="root_"\]\) a \{\s*\n\s*unicode-bidi: plaintext;/.test(src)) {
    failures.push('anchor unicode-bidi rule missing from Auto-mode CSS');
}

if (failures.length) {
    console.error('FAIL — dir-walker scope regression:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
console.log('PASS — dir walker scoped to markdown roots, skip list covers all protected containers');
