# Find Widget for Claude Code Chat — Design Spec

**Date:** 2026-06-25  
**Feature:** Search/Find in chat (MVP)  
**Author:** Brainstorming session with yechiel  
**Status:** Design approved

---

## Overview

Add a **Find widget** to Claude Code's chat panel, styled identically to VS Code's native Find dialog. Users can search within the visible chat content (messages, code blocks, tool outputs) and navigate matches. This is **MVP scope**: search only, no replace; Match Case toggle only (no Regex); search visible text only.

### Goals
- Lightweight, non-intrusive search within long chats
- Familiar UX (VS Code Find widget)
- No impact on RTL modes (orthogonal feature)
- Integrates cleanly into existing injection system

---

## Requirements

### Functional
- User can open Find widget with a button or hotkey
- Input field accepts search text
- Widget shows "X of Y" match counter
- **Previous / Next buttons** navigate between matches
- **Match Case toggle** (case-sensitive search on/off)
- **Close button** hides widget and clears highlights
- Matches highlight with yellow background (VS Code style)
- Scroll-to-match when user clicks Previous/Next

### Non-Functional
- Widget appears **top-right** corner of chat panel, fixed position
- Styling mirrors VS Code's Find widget (colors, spacing, icons)
- Works with dynamic content (MutationObserver detects new messages)
- Minimal JS footprint (no external libraries)
- No impact on RTL toggle or Always/Auto/Active modes

---

## Architecture

### Injection Points

The Find widget is **new, independent content**, injected alongside existing RTL CSS/JS:

```
content.ts:
  ├─ FIND_WIDGET_CSS       (new) — styling for .find-widget, input, buttons
  ├─ FIND_WIDGET_JS        (new) — search logic, highlight/unhighlight, navigation
  └─ [existing RTL CSS/JS]

injector.ts:
  └─ injectFile() — appends both existing + new markers to index.js
```

**Markers:**
```js
/* Find Widget - Added by script */
/* End Find Widget */
```

The widget is **injected in all modes** (Active, Always, Auto, and Plan Preview) because search is independent of RTL state.

---

## UI Layout

### Position & Styling
- **Container:** Fixed div, `position: fixed; top: 0; right: 0; z-index: high`
- **Size:** ~450px wide (matches VS Code)
- **Colors:** Inherit from VS Code theme variables:
  - `var(--vscode-input-background)` for input
  - `var(--vscode-input-foreground)` for text
  - `var(--vscode-input-border)` for border
  - `var(--vscode-button-background)` for buttons

### Components
```
┌─────────────────────────────────────┐
│ [📋]  [Find input]  [2/5]  [↑] [↓] [✕] │
│ ☐ Match Case                        │
└─────────────────────────────────────┘
```

- **📋 Toggle:** Expand/collapse widget (optional, but follows VS Code)
- **Find input:** Placeholder "Find", autocomplete off
- **Counter:** "X of Y" (e.g., "3 of 7")
- **↑ / ↓ buttons:** Previous/Next match
- **✕ button:** Close
- **Match Case toggle:** Checkbox with label

---

## JavaScript Logic

### High-Level Flow

1. **User types in input field**
   - Debounce input (100ms) to avoid excessive searches
   - On each keystroke: clear old highlights, search, highlight new matches

2. **Search Algorithm**
   - Walk visible DOM: collect all `textContent` from chat bubbles
   - Split text by search term (case-sensitive or not)
   - Track positions: *which node*, *which index within text*
   - Count matches, update counter

3. **Highlighting**
   - For each match: wrap matched text in `<mark class="find-match">` with yellow bg
   - Store highlight nodes for cleanup later

4. **Navigation (Previous / Next)**
   - Track "current match index" (0-based)
   - On Next: increment index, scroll to that match, update counter
   - On Previous: decrement index, scroll, update counter
   - Wrap around: if at end, next → go to first; if at start, previous → go to last

5. **Close**
   - Remove all `<mark>` nodes, restore original text
   - Hide widget div
   - Clear search input

6. **Dynamic Content (MutationObserver)**
   - Watch for new messages appended to DOM
   - Re-run search if new content added (maintains highlight consistency)

### Implementation Details

**Search Scope:**
- Only search visible text (no hidden/collapsed elements)
- Exclude code block syntax highlighting markers (search plain text only)
- Include tool outputs, thinking blocks if expanded

**Match Case:**
- `true` → `text.includes(searchTerm)` (case-sensitive)
- `false` → `text.toLowerCase().includes(searchTerm.toLowerCase())`

**Performance:**
- Debounce 100ms on input change
- Limit DOM traversal to chat container only
- Cache match positions (re-compute only on text change)

---

## CSS Styling

### Classes
- `.find-widget` — main container
- `.find-widget.hidden` — display: none
- `.find-widget input` — input field styling
- `.find-widget button` — button styling (icon buttons, small)
- `.find-widget .counter` — match counter text
- `.find-widget .toggle-case` — checkbox toggle
- `.find-match` — applied to matched text, yellow background

### Colors (inherit from VS Code)
```css
.find-widget input {
  background-color: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
}

.find-match {
  background-color: var(--vscode-editor-findMatchBackground, rgba(255, 200, 0, 0.3));
  outline: 1px solid var(--vscode-editor-findMatchBorder, rgba(255, 150, 0, 0.8));
}

.find-match.current {
  background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 100, 0, 0.5));
}
```

---

## Integration with Existing Code

### content.ts Changes
- Add `FIND_WIDGET_CSS` constant (CSS rules for widget)
- Add `FIND_WIDGET_JS` constant (JavaScript logic)
- Update `generateActiveCssRules()`, `generateAlwaysCssRules()`, `generateAutoCssRules()` to include `FIND_WIDGET_CSS`
- Add new export: `function getFindWidgetCode()` that returns CSS + JS combined

### injector.ts Changes
- When injecting RTL JS, also append Find widget JS (same marker approach)
- No changes to backup/restore logic (Find widget is pure append)

### Extension entry point (extension.ts)
- No changes needed (injection is automatic via injector.ts)

---

## Testing Strategy

### Manual Testing (MVP)
1. **Open a long chat** with many messages
2. **Open Find widget** (button in chat or hotkey Ctrl+Shift+F)
3. **Type search term** → verify matches highlight, counter updates
4. **Toggle Match Case** → verify search updates
5. **Click Previous/Next** → verify scroll, counter increments/decrements
6. **Close widget** → verify highlights removed, widget hidden
7. **Test with RTL content** → verify search works on Hebrew/Arabic text and highlights persist through RTL toggle

### Regression Testing
- Run existing `npm test` (concurrency test) — should pass unchanged
- Verify RTL toggle still works with Find widget open
- Verify Plan Preview still renders correctly

---

## Out of Scope (Future)

- Replace functionality (preserve for future, but exclude MVP)
- Regex support (exclude MVP, add as v1.1)
- Find in Selection (exclude MVP)
- Keyboard shortcuts (Ctrl+F, Enter/Shift+Enter for nav) — add in v1.1
- Match Whole Word toggle (exclude MVP)
- Syntax highlighting inside matched code blocks (exclude MVP, requires deeper DOM parsing)

---

## Open Questions / TBD

- **Hotkey:** Should Find widget open on Ctrl+F, or only via button? (Deferred: v1.1 — for now, button only)
- **Toggle button placement:** Same row as RTL toggle, or separate? (Design decision: separate row, top-right, doesn't interfere with RTL toggle)
- **Animation:** Should widget slide in, fade in, or just appear? (Deferred: MVP = instant; v1.1 can add transition)
- **Accessibility:** ARIA labels for buttons? (Yes, include in v1.0 — necessary for screen readers)

---

## Success Criteria

✅ User can search text in chat  
✅ Matches highlight visibly  
✅ Counter shows "X of Y"  
✅ Previous/Next navigate between matches  
✅ Match Case toggle works  
✅ Close clears highlights and hides widget  
✅ Widget styled like VS Code Find  
✅ Works with RTL content (Hebrew/Arabic)  
✅ RTL toggle doesn't break Find  
✅ No impact on existing concurrency tests  

---

## Files to Modify

1. **src/content.ts**
   - Add `FIND_WIDGET_CSS` constant
   - Add `FIND_WIDGET_JS` constant
   - Update `generateActiveCssRules()`, `generateAlwaysCssRules()`, `generateAutoCssRules()`

2. **src/injector.ts**
   - (Minor) Ensure Find widget JS is appended alongside RTL JS (already handled by current marker logic)

3. **Test:** Create `test/find-widget.test.cjs` (future: regression test for Find functionality)

---

## Estimated Effort

- **CSS:** ~1 hour (styling, layout)
- **JS (search + highlight):** ~3-4 hours (debounce, DOM traversal, state management)
- **JS (navigation + cleanup):** ~1-2 hours (Previous/Next, Close, highlight removal)
- **Integration + testing:** ~1 hour

**Total MVP:** ~6-8 hours
