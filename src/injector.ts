import * as fs from 'fs/promises';
import * as path from 'path';
import { ClaudeExtensionInfo, RtlMode, RtlStatus } from './types.js';
import {
    RTL_JS_CODE,
    RTL_START_MARKER, RTL_END_MARKER,
    JS_START_MARKER, JS_END_MARKER,
    JS_MODE_ACTIVE_MARKER, JS_MODE_AUTO_MARKER,
    RTL_MODE_ALWAYS_MARKER, RTL_MODE_AUTO_MARKER, RTL_MODE_LTR_MARKER,
    RTL_AUTO_JS_CODE,
    generateActiveCssRules, generateAlwaysCssRules, generateAutoCssRules, generateLtrCssRules,
    PLAN_CSS_START_MARKER, PLAN_CSS_END_MARKER,
    PLAN_CSS_MODE_ACTIVE_MARKER, PLAN_CSS_MODE_ALWAYS_MARKER,
    PLAN_CSS_MODE_AUTO_MARKER, PLAN_CSS_MODE_LTR_MARKER,
    PLAN_JS_START_MARKER, PLAN_JS_END_MARKER,
    PLAN_JS_MODE_ACTIVE_MARKER, PLAN_JS_MODE_AUTO_MARKER,
    generatePlanActiveCss, PLAN_ACTIVE_JS,
    generatePlanAlwaysCss,
    generatePlanAutoCss, PLAN_AUTO_JS,
    generatePlanLtrCss,
    FontOptions,
} from './content.js';

/**
 * Check if a path exists.
 */
async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

function hasCompleteBlock(content: string, startMarker: string, endMarker: string): boolean {
    const startIdx = content.indexOf(startMarker);
    return startIdx !== -1 && content.indexOf(endMarker, startIdx + startMarker.length) !== -1;
}

function hasManagedBlock(content: string, startMarker: string, endMarker: string): boolean {
    return content.includes(startMarker) || content.includes(endMarker);
}

// ── Concurrency-safe file IO ──────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding an exclusive lock file in `lockDir`.
 *
 * Every open IDE window runs its own extension host, and they all patch the
 * SAME Claude Code files on disk. Without serialization their copyFile + read +
 * write calls interleave and produce a torn/truncated file (observed: index.js
 * shrinking from 4.8 MB to ~1 MB, which blanks the Claude panel). This lock
 * guarantees one injection at a time per extension directory, across windows
 * and processes.
 *
 * Fail closed: lock files are never reclaimed automatically because deleting
 * a stale pathname cannot be made atomic with verifying its owner on every
 * supported platform. After a crash, the error names the file users may remove
 * manually once every IDE window is closed.
 */
async function withFileLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = path.join(lockDir, '.ybyrtl.lock');
    const RETRY_MS = 100;
    const MAX_WAIT_MS = process.env.NODE_ENV === 'test'
        ? Number(process.env.RTL_TEST_LOCK_TIMEOUT_MS ?? 250)
        : 20_000;

    let handle: fs.FileHandle | undefined;
    const start = Date.now();
    while (true) {
        try {
            handle = await fs.open(lockPath, 'wx'); // exclusive create — fails if held
            await handle.writeFile(String(process.pid));
            break;
        } catch (e) {
            const err = e as NodeJS.ErrnoException;
            if (err.code !== 'EEXIST') throw err;

            if (Date.now() - start > MAX_WAIT_MS) {
                const owner = await fs.readFile(lockPath, 'utf-8').catch(() => 'unknown');
                throw new Error(
                    `Timed out waiting for RTL file lock (owner PID: ${owner}). ` +
                    `Close all IDE windows, then remove this lock manually: ${lockPath}`,
                );
            }
            await delay(RETRY_MS);
        }
    }

    try {
        return await fn();
    } finally {
        if (handle) {
            await handle.close().catch(() => { /* ignore */ });
            await fs.rm(lockPath, { force: true }).catch(() => { /* ignore */ });
        }
    }
}

/**
 * Write a file atomically: write to a unique temp file, then rename over the
 * target. rename(2) is atomic on POSIX, so a reader (or a racing window) never
 * observes a half-written file.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
    const tmpPath = `${filePath}.ybytmp.${process.pid}`;
    try {
        await fs.writeFile(tmpPath, data, 'utf-8');
        await fs.rename(tmpPath, filePath);
    } catch (e) {
        await fs.rm(tmpPath, { force: true }).catch(() => { /* ignore */ });
        throw e;
    }
}

/**
 * Check if RTL CSS markers exist in the file.
 */
export async function isCssInstalled(cssPath: string): Promise<boolean> {
    try {
        const content = await fs.readFile(cssPath, 'utf-8');
        return hasCompleteBlock(content, RTL_START_MARKER, RTL_END_MARKER);
    } catch {
        return false;
    }
}

/**
 * Check if JS toggle markers exist in the file.
 */
async function isJsInstalled(jsPath: string | null): Promise<boolean> {
    if (!jsPath) return false;
    try {
        const content = await fs.readFile(jsPath, 'utf-8');
        return hasCompleteBlock(content, JS_START_MARKER, JS_END_MARKER);
    } catch {
        return false;
    }
}

async function hasJsManagedBlock(jsPath: string | null): Promise<boolean> {
    if (!jsPath) return false;
    try {
        const content = await fs.readFile(jsPath, 'utf-8');
        return hasManagedBlock(content, JS_START_MARKER, JS_END_MARKER);
    } catch {
        return false;
    }
}

async function getJsMode(jsPath: string | null): Promise<'active' | 'auto' | null> {
    if (!jsPath) return null;
    try {
        const content = await fs.readFile(jsPath, 'utf-8');
        if (!hasCompleteBlock(content, JS_START_MARKER, JS_END_MARKER)) return null;
        if (content.includes(JS_MODE_AUTO_MARKER)) return 'auto';
        if (content.includes(JS_MODE_ACTIVE_MARKER)) return 'active';
        return null;
    } catch {
        return null;
    }
}

/**
 * Strip a marked block from content string.
 */
function stripBlock(content: string, startMarker: string, endMarker: string): string {
    const startIdx = content.indexOf(startMarker);
    const endIdx = startIdx === -1 ? -1 : content.indexOf(endMarker, startIdx + startMarker.length);
    if (startIdx === -1 || endIdx === -1) return content;

    let actualStart = startIdx;
    const actualEnd = endIdx + endMarker.length;

    // Remove preceding newline if present
    if (actualStart > 0 && content[actualStart - 1] === '\n') {
        actualStart -= 1;
    }

    return content.substring(0, actualStart) + content.substring(actualEnd);
}

// ── Injection helpers ─────────────────────────────────────────────

interface InjectionResult {
    messages: string[];
    changed: boolean;
}

/**
 * Restore a file from backup (or create backup if first time),
 * then append injected content.
 */
async function injectFile(
    filePath: string,
    injectedContent: string,
    startMarker: string,
    endMarker: string,
    label: string,
    messages: string[],
): Promise<boolean> {
    try {
        const backupPath = filePath + '.bak';

        const current = await fs.readFile(filePath, 'utf-8');
        const hasManagedBlock = current.includes(startMarker);
        const hasBackup = await exists(backupPath);
        const existingBackup = hasBackup ? await fs.readFile(backupPath, 'utf-8') : null;
        const currentIsAmbiguousPrefix = existingBackup !== null &&
            current.length < existingBackup.length && existingBackup.startsWith(current);
        if (!hasManagedBlock && currentIsAmbiguousPrefix) {
            messages.push(
                `  ${label}: Aborted — current file is an ambiguous shorter prefix of its backup; ` +
                'both files were preserved for manual recovery',
            );
            return false;
        }
        // If our markers are still present, the current file may be a torn
        // result from an earlier race, so restore only with that positive
        // evidence. Markerless prefixes are ambiguous and fail closed above.
        const preserveBackup = hasBackup && hasManagedBlock;
        const pristine = preserveBackup
            ? existingBackup!
            : stripBlock(current, startMarker, endMarker);
        if (!preserveBackup) {
            await atomicWrite(backupPath, pristine);
            messages.push(`  ${label}: Backup refreshed: ${backupPath}`);
        } else {
            messages.push(`  ${label}: Preserved existing backup`);
        }

        // Keep exactly one owned separator before the marked block and no
        // trailing whitespace after it, so stripBlock restores byte-for-byte.
        const newContent = pristine + '\n' + injectedContent.trim();
        // Corruption guard: injection only ADDS content, so the result must be
        // at least as large as the pristine backup. A smaller result means we
        // read a torn file (e.g. a racing window truncated it) — abort without
        // writing so the good backup is preserved.
        const backupBytes = (await fs.stat(backupPath)).size;
        if (Buffer.byteLength(newContent, 'utf-8') < backupBytes) {
            messages.push(`  ${label}: Aborted — result (${Buffer.byteLength(newContent, 'utf-8')}B) smaller than backup (${backupBytes}B); corruption guard, file left untouched`);
            return false;
        }
        await atomicWrite(filePath, newContent);
        return true;
    } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EPERM' || err.code === 'EACCES') {
            messages.push(`  ${label}: Permission denied: ${filePath}`);
            messages.push('       Try running with elevated privileges');
        } else {
            messages.push(`  ${label}: Error: ${err.message}`);
        }
        return false;
    }
}

/**
 * Restore a file from backup and delete the backup.
 * Used when removing JS injection in Always mode.
 */
async function restoreAndDeleteBackup(
    filePath: string,
    label: string,
    messages: string[],
): Promise<boolean> {
    const backupPath = filePath + '.bak';
    if (!(await exists(backupPath))) return false;

    try {
        await fs.copyFile(backupPath, filePath);
        await fs.unlink(backupPath);
        messages.push(`  ${label}: Restored from backup (backup deleted)`);
        return true;
    } catch (e: unknown) {
        messages.push(`  ${label}: Error restoring: ${(e as Error).message}`);
        return false;
    }
}

// ── Plan Preview injection ────────────────────────────────────────

/** Anchor used to locate the Plan Preview HTML template inside extension.js */
const PLAN_TEMPLATE_ANCHOR = '<div id="content"></div>';

/**
 * Inject RTL CSS (and optionally JS) into the Plan Preview template
 * embedded in Claude Code's extension.js.
 */
async function injectPlanPreview(
    extensionJsPath: string | null,
    cssContent: string,
    jsContent: string | null,
    messages: string[],
): Promise<boolean> {
    if (!extensionJsPath) {
        messages.push('  Plan: extension.js not found, skipping Plan Preview injection');
        return false;
    }

    try {
        const backupPath = extensionJsPath + '.bak';

        const current = await fs.readFile(extensionJsPath, 'utf-8');
        const hasManagedBlock = current.includes(PLAN_CSS_START_MARKER) || current.includes(PLAN_JS_START_MARKER);
        const hasBackup = await exists(backupPath);
        const existingBackup = hasBackup ? await fs.readFile(backupPath, 'utf-8') : null;
        const currentIsAmbiguousPrefix = existingBackup !== null &&
            current.length < existingBackup.length && existingBackup.startsWith(current);
        if (!hasManagedBlock && currentIsAmbiguousPrefix) {
            messages.push(
                '  Plan: Aborted — current file is an ambiguous shorter prefix of its backup; ' +
                'both files were preserved for manual recovery',
            );
            return false;
        }
        let content: string;
        if (hasBackup && hasManagedBlock) {
            content = existingBackup!;
            messages.push('  Plan: Preserved existing backup');
        } else {
            content = stripBlock(current, PLAN_CSS_START_MARKER, PLAN_CSS_END_MARKER);
            content = stripBlock(content, PLAN_JS_START_MARKER, PLAN_JS_END_MARKER);
            await atomicWrite(backupPath, content);
            messages.push(`  Plan: Backup refreshed: ${backupPath}`);
        }

        const leaveUnsupportedPlanClean = async (message: string): Promise<false> => {
            messages.push(message);
            if (hasManagedBlock) {
                await atomicWrite(extensionJsPath, content);
                messages.push('  Plan: Removed stale Plan injection from unsupported template');
            }
            return false;
        };

        // Find the Plan Preview template by its unique anchor
        const anchorIdx = content.indexOf(PLAN_TEMPLATE_ANCHOR);
        if (anchorIdx === -1) {
            return leaveUnsupportedPlanClean('  Plan: Plan Preview template not found in extension.js (older Claude Code version?)');
        }

        // Find </style> before the anchor — this is the plan template's style block
        const styleEndTag = '</style>';
        const styleEndIdx = content.lastIndexOf(styleEndTag, anchorIdx);
        if (styleEndIdx === -1) {
            return leaveUnsupportedPlanClean('  Plan: Could not locate </style> in Plan Preview template');
        }

        const readyMsg = "vscode.postMessage({ type: 'ready' })";
        const readyIdx = jsContent ? content.indexOf(readyMsg, anchorIdx) : -1;
        if (jsContent && readyIdx === -1) {
            return leaveUnsupportedPlanClean('  Plan: Could not locate JS injection point in Plan Preview template');
        }

        // Inject CSS before </style>
        content = content.substring(0, styleEndIdx) +
            '\n' + cssContent + '\n' +
            content.substring(styleEndIdx);

        // Inject JS if provided
        if (jsContent) {
            // Re-find the anchor (position shifted after CSS injection)
            const newAnchorIdx = content.indexOf(PLAN_TEMPLATE_ANCHOR);
            const shiftedReadyIdx = content.indexOf(readyMsg, newAnchorIdx);
            content = content.substring(0, shiftedReadyIdx) +
                jsContent + '\n      ' +
                content.substring(shiftedReadyIdx);
            messages.push('  Plan: RTL JS injected into Plan Preview');
        }

        // Corruption guard: Plan Preview injection only inserts content, so the
        // result must be at least as large as the pristine backup. Bail out on a
        // smaller result rather than persist a torn extension.js.
        const backupBytes = (await fs.stat(backupPath)).size;
        if (Buffer.byteLength(content, 'utf-8') < backupBytes) {
            messages.push(`  Plan: Aborted — result (${Buffer.byteLength(content, 'utf-8')}B) smaller than backup (${backupBytes}B); corruption guard, file left untouched`);
            return false;
        }
        await atomicWrite(extensionJsPath, content);
        messages.push('  Plan: RTL CSS injected into Plan Preview');
        return true;
    } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EPERM' || err.code === 'EACCES') {
            messages.push(`  Plan: Permission denied: ${extensionJsPath}`);
        } else {
            messages.push(`  Plan: Error: ${err.message}`);
        }
        return false;
    }
}

/**
 * Check if Plan Preview RTL is installed in extension.js.
 */
async function isPlanPreviewInstalled(extensionJsPath: string | null): Promise<boolean> {
    if (!extensionJsPath) return false;
    try {
        const content = await fs.readFile(extensionJsPath, 'utf-8');
        return hasCompleteBlock(content, PLAN_CSS_START_MARKER, PLAN_CSS_END_MARKER);
    } catch {
        return false;
    }
}

async function getPlanPreviewMode(extensionJsPath: string | null): Promise<Exclude<RtlMode, 'inactive'> | null> {
    if (!extensionJsPath) return null;
    try {
        const content = await fs.readFile(extensionJsPath, 'utf-8');
        if (!hasCompleteBlock(content, PLAN_CSS_START_MARKER, PLAN_CSS_END_MARKER)) return null;
        if (content.includes(PLAN_CSS_MODE_AUTO_MARKER)) return 'auto';
        if (content.includes(PLAN_CSS_MODE_LTR_MARKER)) return 'ltr';
        if (content.includes(PLAN_CSS_MODE_ALWAYS_MARKER)) return 'always';
        if (content.includes(PLAN_CSS_MODE_ACTIVE_MARKER)) return 'active';
        return null;
    } catch {
        return null;
    }
}

async function isPlanPreviewJsInstalled(extensionJsPath: string | null): Promise<boolean> {
    if (!extensionJsPath) return false;
    try {
        const content = await fs.readFile(extensionJsPath, 'utf-8');
        return hasCompleteBlock(content, PLAN_JS_START_MARKER, PLAN_JS_END_MARKER);
    } catch {
        return false;
    }
}

async function hasPlanCssManagedBlock(extensionJsPath: string | null): Promise<boolean> {
    if (!extensionJsPath) return false;
    try {
        const content = await fs.readFile(extensionJsPath, 'utf-8');
        return hasManagedBlock(content, PLAN_CSS_START_MARKER, PLAN_CSS_END_MARKER);
    } catch {
        return false;
    }
}

async function hasPlanJsManagedBlock(extensionJsPath: string | null): Promise<boolean> {
    if (!extensionJsPath) return false;
    try {
        const content = await fs.readFile(extensionJsPath, 'utf-8');
        return hasManagedBlock(content, PLAN_JS_START_MARKER, PLAN_JS_END_MARKER);
    } catch {
        return false;
    }
}

async function getPlanPreviewJsMode(extensionJsPath: string | null): Promise<'active' | 'auto' | null> {
    if (!extensionJsPath) return null;
    try {
        const content = await fs.readFile(extensionJsPath, 'utf-8');
        if (!hasCompleteBlock(content, PLAN_JS_START_MARKER, PLAN_JS_END_MARKER)) return null;
        if (content.includes(PLAN_JS_MODE_AUTO_MARKER)) return 'auto';
        if (content.includes(PLAN_JS_MODE_ACTIVE_MARKER)) return 'active';
        return null;
    } catch {
        return null;
    }
}

async function isPlanPreviewSupported(extensionJsPath: string | null): Promise<boolean> {
    if (!extensionJsPath) return false;
    try {
        const content = await fs.readFile(extensionJsPath, 'utf-8');
        const anchorIdx = content.indexOf(PLAN_TEMPLATE_ANCHOR);
        return anchorIdx !== -1 && content.lastIndexOf('</style>', anchorIdx) !== -1;
    } catch {
        return false;
    }
}

async function isPlanPreviewInteractiveSupported(extensionJsPath: string | null): Promise<boolean> {
    if (!extensionJsPath) return false;
    try {
        const content = await fs.readFile(extensionJsPath, 'utf-8');
        const anchorIdx = content.indexOf(PLAN_TEMPLATE_ANCHOR);
        return anchorIdx !== -1 &&
            content.lastIndexOf('</style>', anchorIdx) !== -1 &&
            content.indexOf("vscode.postMessage({ type: 'ready' })", anchorIdx) !== -1;
    } catch {
        return false;
    }
}

/** Return whether every component available in this Claude installation is healthy. */
export function isModeFullyInstalled(status: RtlStatus, expectedMode: RtlMode): boolean {
    if (status.mode !== expectedMode) return false;
    if (expectedMode === 'inactive') {
        return !status.cssManagedBlockPresent && !status.jsManagedBlockPresent &&
            !status.planPreviewCssManagedBlockPresent && !status.planPreviewJsManagedBlockPresent;
    }

    const needsInteractiveJs = expectedMode === 'active' || expectedMode === 'auto';
    if (needsInteractiveJs && status.extension.jsPath && !status.jsInstalled) return false;
    if (needsInteractiveJs && status.extension.jsPath && status.jsMode !== expectedMode) return false;
    if (!needsInteractiveJs && (status.jsManagedBlockPresent || status.planPreviewJsManagedBlockPresent)) return false;
    const planSupported = needsInteractiveJs
        ? status.planPreviewInteractiveSupported
        : status.planPreviewSupported;
    if ((status.planPreviewInstalled || status.planPreviewJsInstalled) && !planSupported) return false;
    if (planSupported && !status.planPreviewInstalled) return false;
    if (planSupported && status.planPreviewMode !== expectedMode) return false;
    if (needsInteractiveJs && planSupported && !status.planPreviewJsInstalled) return false;
    if (needsInteractiveJs && planSupported && status.planPreviewJsMode !== expectedMode) return false;
    return true;
}

// ── Status ────────────────────────────────────────────────────────

/**
 * Get RTL status for all found extensions.
 */
export async function getStatus(extensions: ClaudeExtensionInfo[]): Promise<RtlStatus[]> {
    const statuses: RtlStatus[] = [];

    for (const ext of extensions) {
        let cssContent = '';
        try {
            cssContent = await fs.readFile(ext.cssPath, 'utf-8');
        } catch { /* file unreadable — treat as not installed */ }

        const cssInstalled = hasCompleteBlock(cssContent, RTL_START_MARKER, RTL_END_MARKER);
        const cssManagedBlockPresent = hasManagedBlock(cssContent, RTL_START_MARKER, RTL_END_MARKER);
        const autoMode = cssInstalled && cssContent.includes(RTL_MODE_AUTO_MARKER);
        const ltrMode = cssInstalled && !autoMode && cssContent.includes(RTL_MODE_LTR_MARKER);
        const alwaysMode = cssInstalled && !autoMode && !ltrMode && cssContent.includes(RTL_MODE_ALWAYS_MARKER);

        statuses.push({
            extension: ext,
            cssInstalled,
            cssManagedBlockPresent,
            jsInstalled: await isJsInstalled(ext.jsPath),
            jsManagedBlockPresent: await hasJsManagedBlock(ext.jsPath),
            jsMode: await getJsMode(ext.jsPath),
            planPreviewInstalled: await isPlanPreviewInstalled(ext.extensionJsPath),
            planPreviewCssManagedBlockPresent: await hasPlanCssManagedBlock(ext.extensionJsPath),
            planPreviewMode: await getPlanPreviewMode(ext.extensionJsPath),
            planPreviewJsInstalled: await isPlanPreviewJsInstalled(ext.extensionJsPath),
            planPreviewJsManagedBlockPresent: await hasPlanJsManagedBlock(ext.extensionJsPath),
            planPreviewJsMode: await getPlanPreviewJsMode(ext.extensionJsPath),
            planPreviewSupported: await isPlanPreviewSupported(ext.extensionJsPath),
            planPreviewInteractiveSupported: await isPlanPreviewInteractiveSupported(ext.extensionJsPath),
            cssBackupExists: await exists(ext.cssPath + '.bak'),
            jsBackupExists: ext.jsPath ? await exists(ext.jsPath + '.bak') : false,
            mode: autoMode ? 'auto' : ltrMode ? 'ltr' : alwaysMode ? 'always' : cssInstalled ? 'active' : 'inactive',
        });
    }

    return statuses;
}

// ── Injection modes ───────────────────────────────────────────────

/**
 * Add RTL support (Active mode) — CSS with .YBYrtl class + toggle button JS.
 */
async function addRtlImpl(ext: ClaudeExtensionInfo, fonts?: FontOptions): Promise<InjectionResult> {
    const messages: string[] = [];
    let changed = false;

    if (await injectFile(ext.cssPath, generateActiveCssRules(fonts), RTL_START_MARKER, RTL_END_MARKER, 'CSS', messages)) {
        messages.push(`  CSS: RTL support added to ${ext.name}`);
        changed = true;
    }

    if (!ext.jsPath) {
        messages.push('  JS:  index.js not found, skipping button injection');
    } else if (await injectFile(ext.jsPath, RTL_JS_CODE, JS_START_MARKER, JS_END_MARKER, 'JS', messages)) {
        messages.push(`  JS:  Toggle button added to ${ext.name}`);
        changed = true;
    }

    if (await injectPlanPreview(ext.extensionJsPath, generatePlanActiveCss(fonts), PLAN_ACTIVE_JS, messages)) {
        changed = true;
    }

    return { messages, changed };
}

/**
 * Add RTL "Always" mode — CSS without .YBYrtl class, no JS button.
 */
async function addRtlAlwaysImpl(ext: ClaudeExtensionInfo, fonts?: FontOptions): Promise<InjectionResult> {
    const messages: string[] = [];
    let changed = false;

    if (await injectFile(ext.cssPath, generateAlwaysCssRules(fonts), RTL_START_MARKER, RTL_END_MARKER, 'CSS', messages)) {
        messages.push(`  CSS: RTL Always support added to ${ext.name}`);
        changed = true;
    }

    // Remove JS button if installed
    if (ext.jsPath && await hasJsManagedBlock(ext.jsPath)) {
        if (await restoreAndDeleteBackup(ext.jsPath, 'JS', messages)) {
            changed = true;
        }
    } else {
        messages.push(`  JS:  No button to remove (Always mode — no JS needed)`);
    }

    if (await injectPlanPreview(ext.extensionJsPath, generatePlanAlwaysCss(fonts), null, messages)) {
        changed = true;
    }

    return { messages, changed };
}

/**
 * Add RTL "Auto" mode — per-element Hebrew detection via JS MutationObserver.
 */
async function addRtlAutoImpl(ext: ClaudeExtensionInfo, fonts?: FontOptions): Promise<InjectionResult> {
    const messages: string[] = [];
    let changed = false;

    if (await injectFile(ext.cssPath, generateAutoCssRules(fonts), RTL_START_MARKER, RTL_END_MARKER, 'CSS', messages)) {
        messages.push(`  CSS: RTL Auto support added to ${ext.name}`);
        changed = true;
    }

    if (!ext.jsPath) {
        messages.push('  JS:  index.js not found, skipping auto-detection injection');
    } else if (await injectFile(ext.jsPath, RTL_AUTO_JS_CODE, JS_START_MARKER, JS_END_MARKER, 'JS', messages)) {
        messages.push(`  JS:  Auto-detection script added to ${ext.name}`);
        changed = true;
    }

    if (await injectPlanPreview(ext.extensionJsPath, generatePlanAutoCss(fonts), PLAN_AUTO_JS, messages)) {
        changed = true;
    }

    return { messages, changed };
}

/**
 * Add "LTR Always" mode — force left-to-right everywhere, no JS button.
 * Gives users of LTR languages a way to pin the layout even when the
 * conversation contains Hebrew/Arabic text.
 */
async function addLtrAlwaysImpl(ext: ClaudeExtensionInfo, fonts?: FontOptions): Promise<InjectionResult> {
    const messages: string[] = [];
    let changed = false;

    if (await injectFile(ext.cssPath, generateLtrCssRules(fonts), RTL_START_MARKER, RTL_END_MARKER, 'CSS', messages)) {
        messages.push(`  CSS: LTR Always support added to ${ext.name}`);
        changed = true;
    }

    // Remove JS button if installed
    if (ext.jsPath && await hasJsManagedBlock(ext.jsPath)) {
        if (await restoreAndDeleteBackup(ext.jsPath, 'JS', messages)) {
            changed = true;
        }
    } else {
        messages.push(`  JS:  No button to remove (LTR Always mode — no JS needed)`);
    }

    if (await injectPlanPreview(ext.extensionJsPath, generatePlanLtrCss(fonts), null, messages)) {
        changed = true;
    }

    return { messages, changed };
}

// ── Removal ───────────────────────────────────────────────────────

/**
 * Remove an injected block from a file, trying backup restore first,
 * falling back to manual marker-based removal.
 */
async function removeInjected(
    filePath: string,
    isInstalled: boolean,
    startMarker: string,
    endMarker: string,
    label: string,
    extName: string,
    messages: string[],
): Promise<boolean> {
    if (!isInstalled) {
        messages.push(`  ${label}: RTL not installed in ${extName}`);
        return false;
    }

    // Try backup restore first
    if (await restoreAndDeleteBackup(filePath, label, messages)) {
        return true;
    }

    // Fallback: manual marker removal
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const cleaned = stripBlock(content, startMarker, endMarker);
        await atomicWrite(filePath, cleaned);
        messages.push(`  ${label}: RTL removed from ${extName}`);
        return true;
    } catch (e: unknown) {
        messages.push(`  ${label}: Error removing RTL: ${(e as Error).message}`);
        return false;
    }
}

/**
 * Remove RTL support from a single Claude Code extension.
 */
async function removeRtlImpl(ext: ClaudeExtensionInfo): Promise<InjectionResult> {
    const messages: string[] = [];
    let changed = false;

    const cssContent = await fs.readFile(ext.cssPath, 'utf-8').catch(() => '');
    if (await removeInjected(ext.cssPath, hasManagedBlock(cssContent, RTL_START_MARKER, RTL_END_MARKER), RTL_START_MARKER, RTL_END_MARKER, 'CSS', ext.name, messages)) {
        changed = true;
    }

    const jsManaged = ext.jsPath ? await hasJsManagedBlock(ext.jsPath) : false;
    if (!ext.jsPath || !jsManaged) {
        messages.push(`  JS:  Button not installed in ${ext.name}`);
    } else if (await removeInjected(ext.jsPath, jsManaged, JS_START_MARKER, JS_END_MARKER, 'JS', ext.name, messages)) {
        changed = true;
    }

    // Restore extension.js (Plan Preview) from backup
    if (ext.extensionJsPath && (await hasPlanCssManagedBlock(ext.extensionJsPath) || await hasPlanJsManagedBlock(ext.extensionJsPath))) {
        if (await restoreAndDeleteBackup(ext.extensionJsPath, 'Plan', messages)) {
            changed = true;
        } else {
            const cssRemoved = await removeInjected(ext.extensionJsPath, true, PLAN_CSS_START_MARKER, PLAN_CSS_END_MARKER, 'Plan CSS', ext.name, messages);
            const jsStillManaged = await hasPlanJsManagedBlock(ext.extensionJsPath);
            const jsRemoved = jsStillManaged
                ? await removeInjected(ext.extensionJsPath, true, PLAN_JS_START_MARKER, PLAN_JS_END_MARKER, 'Plan JS', ext.name, messages)
                : false;
            if (cssRemoved || jsRemoved) changed = true;
        }
    }

    return { messages, changed };
}

// ── Public, lock-serialized entry points ──────────────────────────
//
// Every mutating operation runs under a per-extension-directory lock so that
// concurrent IDE windows can't interleave their read-modify-write cycles and
// corrupt the shared Claude Code files. The *Impl functions stay lock-free
// so callers can compose them without deadlocking on the lock.

export function addRtl(ext: ClaudeExtensionInfo, fonts?: FontOptions): Promise<InjectionResult> {
    return withFileLock(ext.dir, () => addRtlImpl(ext, fonts));
}

export function addRtlAlways(ext: ClaudeExtensionInfo, fonts?: FontOptions): Promise<InjectionResult> {
    return withFileLock(ext.dir, () => addRtlAlwaysImpl(ext, fonts));
}

export function addRtlAuto(ext: ClaudeExtensionInfo, fonts?: FontOptions): Promise<InjectionResult> {
    return withFileLock(ext.dir, () => addRtlAutoImpl(ext, fonts));
}

export function addLtrAlways(ext: ClaudeExtensionInfo, fonts?: FontOptions): Promise<InjectionResult> {
    return withFileLock(ext.dir, () => addLtrAlwaysImpl(ext, fonts));
}

export function removeRtl(ext: ClaudeExtensionInfo): Promise<InjectionResult> {
    return withFileLock(ext.dir, () => removeRtlImpl(ext));
}
