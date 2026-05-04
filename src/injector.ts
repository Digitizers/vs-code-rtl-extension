import * as fs from 'fs/promises';
import { ClaudeExtensionInfo, RtlStatus } from './types.js';
import {
    RTL_CSS_RULES, RTL_JS_CODE,
    RTL_START_MARKER, RTL_END_MARKER,
    JS_START_MARKER, JS_END_MARKER,
    RTL_MODE_ALWAYS_MARKER, RTL_MODE_AUTO_MARKER,
    RTL_AUTO_JS_CODE,
    generateAlwaysCssRules, generateAutoCssRules,
    PLAN_CSS_START_MARKER, PLAN_CSS_END_MARKER,
    PLAN_JS_START_MARKER, PLAN_JS_END_MARKER,
    PLAN_ACTIVE_CSS, PLAN_ACTIVE_JS,
    PLAN_ALWAYS_CSS,
    PLAN_AUTO_CSS, PLAN_AUTO_JS,
} from './content.js';

const BIDI_OVERRIDE = '*{direction:ltr;unicode-bidi:bidi-override}';

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

/**
 * Check if RTL CSS markers exist in the file.
 */
export async function isCssInstalled(cssPath: string): Promise<boolean> {
    try {
        const content = await fs.readFile(cssPath, 'utf-8');
        return content.includes(RTL_START_MARKER);
    } catch {
        return false;
    }
}

/**
 * Check if CSS is in "always" mode (no .YBYrtl class dependency).
 */
export async function isAlwaysMode(cssPath: string): Promise<boolean> {
    try {
        const content = await fs.readFile(cssPath, 'utf-8');
        return content.includes(RTL_MODE_ALWAYS_MARKER);
    } catch {
        return false;
    }
}

/**
 * Check if CSS is in "auto" mode (per-element Hebrew detection).
 */
export async function isAutoMode(cssPath: string): Promise<boolean> {
    try {
        const content = await fs.readFile(cssPath, 'utf-8');
        return content.includes(RTL_MODE_AUTO_MARKER);
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
        return content.includes(JS_START_MARKER);
    } catch {
        return false;
    }
}

/**
 * Strip a marked block from content string.
 */
function stripBlock(content: string, startMarker: string, endMarker: string): string {
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);
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
    label: string,
    messages: string[],
    options?: { fixBidi?: boolean },
): Promise<boolean> {
    try {
        const backupPath = filePath + '.bak';

        if (await exists(backupPath)) {
            await fs.copyFile(backupPath, filePath);
            messages.push(`  ${label}: Restored from backup`);
        } else {
            await fs.copyFile(filePath, backupPath);
            messages.push(`  ${label}: Backup created: ${backupPath}`);
        }

        let content = await fs.readFile(filePath, 'utf-8');

        if (options?.fixBidi && content.includes(BIDI_OVERRIDE)) {
            content = content.replace(BIDI_OVERRIDE, '');
            messages.push(`  ${label}: Removed bidi-override rule`);
        }

        await fs.writeFile(filePath, content + '\n' + injectedContent, 'utf-8');
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

        // Restore from backup if it exists, otherwise create backup
        if (await exists(backupPath)) {
            await fs.copyFile(backupPath, extensionJsPath);
            messages.push('  Plan: Restored extension.js from backup');
        } else {
            await fs.copyFile(extensionJsPath, backupPath);
            messages.push(`  Plan: Backup created: ${backupPath}`);
        }

        let content = await fs.readFile(extensionJsPath, 'utf-8');

        // Find the Plan Preview template by its unique anchor
        const anchorIdx = content.indexOf(PLAN_TEMPLATE_ANCHOR);
        if (anchorIdx === -1) {
            messages.push('  Plan: Plan Preview template not found in extension.js (older Claude Code version?)');
            return false;
        }

        // Find </style> before the anchor — this is the plan template's style block
        const styleEndTag = '</style>';
        const styleEndIdx = content.lastIndexOf(styleEndTag, anchorIdx);
        if (styleEndIdx === -1) {
            messages.push('  Plan: Could not locate </style> in Plan Preview template');
            return false;
        }

        // Inject CSS before </style>
        content = content.substring(0, styleEndIdx) +
            '\n' + cssContent + '\n' +
            content.substring(styleEndIdx);

        // Inject JS if provided
        if (jsContent) {
            // Re-find the anchor (position shifted after CSS injection)
            const newAnchorIdx = content.indexOf(PLAN_TEMPLATE_ANCHOR);
            const readyMsg = "vscode.postMessage({ type: 'ready' })";
            const readyIdx = content.indexOf(readyMsg, newAnchorIdx);
            if (readyIdx === -1) {
                messages.push('  Plan: Could not locate JS injection point in Plan Preview template');
            } else {
                content = content.substring(0, readyIdx) +
                    jsContent + '\n      ' +
                    content.substring(readyIdx);
                messages.push('  Plan: RTL JS injected into Plan Preview');
            }
        }

        await fs.writeFile(extensionJsPath, content, 'utf-8');
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
        return content.includes(PLAN_CSS_START_MARKER);
    } catch {
        return false;
    }
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

        const cssInstalled = cssContent.includes(RTL_START_MARKER);
        const autoMode = cssInstalled && cssContent.includes(RTL_MODE_AUTO_MARKER);
        const alwaysMode = cssInstalled && !autoMode && cssContent.includes(RTL_MODE_ALWAYS_MARKER);

        statuses.push({
            extension: ext,
            cssInstalled,
            jsInstalled: await isJsInstalled(ext.jsPath),
            planPreviewInstalled: await isPlanPreviewInstalled(ext.extensionJsPath),
            cssBackupExists: await exists(ext.cssPath + '.bak'),
            jsBackupExists: ext.jsPath ? await exists(ext.jsPath + '.bak') : false,
            mode: autoMode ? 'auto' : alwaysMode ? 'always' : cssInstalled ? 'active' : 'inactive',
        });
    }

    return statuses;
}

// ── Injection modes ───────────────────────────────────────────────

/**
 * Add RTL support (Active mode) — CSS with .YBYrtl class + toggle button JS.
 */
export async function addRtl(ext: ClaudeExtensionInfo): Promise<InjectionResult> {
    const messages: string[] = [];
    let changed = false;

    if (await injectFile(ext.cssPath, RTL_CSS_RULES, 'CSS', messages)) {
        messages.push(`  CSS: RTL support added to ${ext.name}`);
        changed = true;
    }

    if (!ext.jsPath) {
        messages.push('  JS:  index.js not found, skipping button injection');
    } else if (await injectFile(ext.jsPath, RTL_JS_CODE, 'JS', messages)) {
        messages.push(`  JS:  Toggle button added to ${ext.name}`);
        changed = true;
    }

    if (await injectPlanPreview(ext.extensionJsPath, PLAN_ACTIVE_CSS, PLAN_ACTIVE_JS, messages)) {
        changed = true;
    }

    return { messages, changed };
}

/**
 * Add RTL "Always" mode — CSS without .YBYrtl class, no JS button.
 */
export async function addRtlAlways(ext: ClaudeExtensionInfo): Promise<InjectionResult> {
    const messages: string[] = [];
    let changed = false;

    if (await injectFile(ext.cssPath, generateAlwaysCssRules(), 'CSS', messages, { fixBidi: true })) {
        messages.push(`  CSS: RTL Always support added to ${ext.name}`);
        changed = true;
    }

    // Remove JS button if installed
    if (ext.jsPath && await isJsInstalled(ext.jsPath)) {
        if (await restoreAndDeleteBackup(ext.jsPath, 'JS', messages)) {
            changed = true;
        }
    } else {
        messages.push(`  JS:  No button to remove (Always mode — no JS needed)`);
    }

    if (await injectPlanPreview(ext.extensionJsPath, PLAN_ALWAYS_CSS, null, messages)) {
        changed = true;
    }

    return { messages, changed };
}

/**
 * Add RTL "Auto" mode — per-element Hebrew detection via JS MutationObserver.
 */
export async function addRtlAuto(ext: ClaudeExtensionInfo): Promise<InjectionResult> {
    const messages: string[] = [];
    let changed = false;

    if (await injectFile(ext.cssPath, generateAutoCssRules(), 'CSS', messages, { fixBidi: true })) {
        messages.push(`  CSS: RTL Auto support added to ${ext.name}`);
        changed = true;
    }

    if (!ext.jsPath) {
        messages.push('  JS:  index.js not found, skipping auto-detection injection');
    } else if (await injectFile(ext.jsPath, RTL_AUTO_JS_CODE, 'JS', messages)) {
        messages.push(`  JS:  Auto-detection script added to ${ext.name}`);
        changed = true;
    }

    if (await injectPlanPreview(ext.extensionJsPath, PLAN_AUTO_CSS, PLAN_AUTO_JS, messages)) {
        changed = true;
    }

    return { messages, changed };
}

/**
 * Add RTL support and fix BiDi issue by removing the bidi-override rule.
 * Preserves the current mode.
 */
export async function fixBidi(ext: ClaudeExtensionInfo): Promise<InjectionResult> {
    const currentlyAuto = await isAutoMode(ext.cssPath);
    const currentlyAlways = !currentlyAuto && await isAlwaysMode(ext.cssPath);
    const result = currentlyAuto ? await addRtlAuto(ext) : currentlyAlways ? await addRtlAlways(ext) : await addRtl(ext);

    // After injection, remove the bidi-override rule if still present
    try {
        const content = await fs.readFile(ext.cssPath, 'utf-8');
        if (content.includes(BIDI_OVERRIDE)) {
            const fixed = content.replace(BIDI_OVERRIDE, '');
            await fs.writeFile(ext.cssPath, fixed, 'utf-8');
            result.messages.push(`  CSS: Removed bidi-override rule`);
        }
    } catch (e: unknown) {
        result.messages.push(`  CSS: Error fixing BiDi: ${(e as Error).message}`);
    }

    return result;
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
        await fs.writeFile(filePath, cleaned, 'utf-8');
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
export async function removeRtl(ext: ClaudeExtensionInfo): Promise<InjectionResult> {
    const messages: string[] = [];
    let changed = false;

    if (await removeInjected(ext.cssPath, await isCssInstalled(ext.cssPath), RTL_START_MARKER, RTL_END_MARKER, 'CSS', ext.name, messages)) {
        changed = true;
    }

    const jsInstalled = ext.jsPath ? await isJsInstalled(ext.jsPath) : false;
    if (!ext.jsPath || !jsInstalled) {
        messages.push(`  JS:  Button not installed in ${ext.name}`);
    } else if (await removeInjected(ext.jsPath, jsInstalled, JS_START_MARKER, JS_END_MARKER, 'JS', ext.name, messages)) {
        changed = true;
    }

    // Restore extension.js (Plan Preview) from backup
    if (ext.extensionJsPath && await isPlanPreviewInstalled(ext.extensionJsPath)) {
        if (await restoreAndDeleteBackup(ext.extensionJsPath, 'Plan', messages)) {
            changed = true;
        }
    }

    return { messages, changed };
}
