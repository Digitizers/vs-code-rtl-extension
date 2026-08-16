/** Represents a discovered Claude Code extension installation */
export interface ClaudeExtensionInfo {
    /** Full path to the extension directory */
    dir: string;
    /** Full path to webview/index.css */
    cssPath: string;
    /** Full path to webview/index.js (may not exist) */
    jsPath: string | null;
    /** Full path to extension.js (for Plan Preview injection) */
    extensionJsPath: string | null;
    /** Directory name, e.g. "anthropic.claude-code-2.1.49-win32-x64" */
    name: string;
}

/** RTL operating mode — 'ltr' forces left-to-right always, even for RTL scripts */
export type RtlMode = 'active' | 'always' | 'auto' | 'ltr' | 'inactive';

/** RTL installation status for a single extension */
export interface RtlStatus {
    extension: ClaudeExtensionInfo;
    cssInstalled: boolean;
    cssManagedBlockPresent: boolean;
    /** True when the configured CSS bundle could not be read */
    cssReadError: boolean;
    jsInstalled: boolean;
    jsManagedBlockPresent: boolean;
    jsMode: 'active' | 'auto' | null;
    /** True when a configured JS bundle could not be read */
    jsReadError: boolean;
    planPreviewInstalled: boolean;
    planPreviewCssManagedBlockPresent: boolean;
    planPreviewMode: Exclude<RtlMode, 'inactive'> | null;
    /** Whether Plan Preview's interactive JS is installed (Active/Auto modes) */
    planPreviewJsInstalled: boolean;
    planPreviewJsManagedBlockPresent: boolean;
    planPreviewJsMode: 'active' | 'auto' | null;
    /** Whether this Claude version contains the Plan Preview template we support */
    planPreviewSupported: boolean;
    /** Whether interactive Plan modes have every required JS injection point */
    planPreviewInteractiveSupported: boolean;
    /** True when a configured Plan bundle exists but could not be read */
    planPreviewReadError: boolean;
    cssBackupExists: boolean;
    jsBackupExists: boolean;
    mode: RtlMode;
}
