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
const injectorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'injector.ts'), 'utf8');
const extensionSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');

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

// 4. Direction detection must ignore text inside skipped containers
//    (Codex round-4 P2, PR #2): a code block quoting Hebrew inside an
//    English list item must not flip the item to RTL.
if (!/function hasOwnRtl/.test(w) || !/createTreeWalker/.test(w)) {
    failures.push('walker direction detection no longer excludes skipped-container text (hasOwnRtl/TreeWalker missing)');
}
if (!/hasOwnRtl\(el\)/.test(w)) {
    failures.push('tagBlocks no longer uses skip-aware hasOwnRtl for direction detection');
}

// 5. Independently nested blocks' RTL text must not flip the parent, while
//    loose-list paragraphs still count toward their li (Codex round-5/6 P2s):
//    ownership stops at nested li/blockquote, not at p/headings.
if (!/INDEPENDENT_SEL = 'li,blockquote'/.test(w) || !/function ownsText/.test(w)) {
    failures.push('hasOwnRtl lost the independent-nested-block ownership rule (ownsText/INDEPENDENT_SEL)');
}
if (!/ownsText\(el, p\)/.test(w)) {
    failures.push('hasOwnRtl no longer consults ownsText for direction detection');
}

// 6. The observer must never full-scan on unrelated mutations (Codex round-5
//    P2): pure-English streaming outside bubbles must not re-walk history.
if (/pendingFull/.test(w) || /scanAll\(\)/.test(w.split('Debounced watcher')[1] || '')) {
    failures.push('observer regained a full-scan fallback (pendingFull/scanAll in mutation path)');
}
if (!/addedNodes/.test(w)) {
    failures.push('observer no longer inspects addedNodes for new bubbles');
}

// 7. Anchors need their own inline bidi run (Codex round-3 P2, PR #2):
//    unicode-bidi is not inherited, so block-level isolation alone leaves
//    URL punctuation reorderable by the surrounding RTL context.
if (!/\[class\*="root_"\]:not\(\[class\*="thinkingContent_"\] \[class\*="root_"\]\) a \{\s*\n\s*unicode-bidi: plaintext;/.test(src)) {
    failures.push('anchor unicode-bidi rule missing from Auto-mode CSS');
}

// 8. Mutations must never proceed after failing to acquire the cross-process lock.
if (!/Timed out waiting for RTL file lock/.test(injectorSrc)) {
    failures.push('file-lock timeout no longer fails closed');
}
if (!/remove this lock manually/.test(injectorSrc) || /fs\.link\(lockPath/.test(injectorSrc)) {
    failures.push('file locking no longer fails closed with manual stale-lock recovery');
}
if (!/noChangeMessage && !anyChanged && incomplete\.length === 0/.test(extensionSrc)) {
    failures.push('no-change message is no longer suppressed after an incomplete operation');
}
if (!/if \(incomplete\.length > 0\) \{\s*await updateStatusBar\(mode\);/.test(extensionSrc)) {
    failures.push('status bar is no longer refreshed immediately after incomplete operations');
}
const statusBarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'statusBar.ts'), 'utf8');
if (!/isModeFullyInstalled\(s, expectedMode\)/.test(statusBarSrc)) {
    failures.push('status bar health is no longer checked against the requested/saved mode');
}

if (failures.length) {
    console.error('FAIL — dir-walker scope regression:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
console.log('PASS — dir walker scoped to markdown roots, skip list covers all protected containers');
