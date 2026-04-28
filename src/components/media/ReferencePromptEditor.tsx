import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

type TextRange = {
  start: number;
  end: number;
};

export type ReferencePromptMention = TextRange & {
  query: string;
  left: number;
  top: number;
};

export type ReferencePromptTokenMeta = {
  title?: string;
  tone?: 'valid' | 'invalid' | 'neutral';
  valid?: boolean;
};

export type ReferencePromptEditorHandle = {
  focus: () => void;
  getBoundingClientRect: () => DOMRect | null;
  getSelectionRange: () => TextRange;
  insertText: (text: string, range?: TextRange) => void;
  setSelectionRange: (start: number, end: number) => void;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  tokenMeta?: (token: string) => ReferencePromptTokenMeta | null | undefined;
  onMentionChange?: (mention: ReferencePromptMention | null) => void;
  onTokenMouseEnter?: (token: string, event: ReactMouseEvent<HTMLElement>) => void;
  onTokenMouseMove?: (token: string, event: ReactMouseEvent<HTMLElement>) => void;
  onTokenMouseLeave?: (token: string, event: ReactMouseEvent<HTMLElement>) => void;
};

const TOKEN_PATTERN = /@([a-z0-9][a-z0-9_-]*)/gi;
const MENTION_PATTERN = /(^|\s)@([a-z0-9_-]{0,64})$/i;

export const ReferencePromptEditor = forwardRef<ReferencePromptEditorHandle, Props>(function ReferencePromptEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = '',
  tokenMeta,
  onMentionChange,
  onTokenMouseEnter,
  onTokenMouseMove,
  onTokenMouseLeave,
}, ref) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  const lastSelectionRef = useRef<TextRange>({ start: value.length, end: value.length });
  const pendingSelectionRef = useRef<TextRange | null>(null);
  const hoveredTokenRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const wasFocused = document.activeElement === root;
    const selectionBeforeRender = wasFocused ? getCurrentSelectionRange(root) : null;
    const html = renderPromptHtml({ value, tokenMeta });
    if (root.innerHTML !== html) root.innerHTML = html;
    valueRef.current = value;
    const pendingSelection = pendingSelectionRef.current;
    if (pendingSelection) {
      pendingSelectionRef.current = null;
      setEditableSelection(root, clampSelection(pendingSelection, value.length));
      return;
    }
    if (wasFocused) {
      const selection = clampSelection(selectionBeforeRender ?? lastSelectionRef.current, value.length);
      setEditableSelection(root, selection);
    }
  }, [tokenMeta, value]);

  const refreshMention = (text: string, cursor: number) => {
    if (!onMentionChange) return;
    const prefix = text.slice(0, cursor);
    const match = prefix.match(MENTION_PATTERN);
    if (!match) {
      onMentionChange(null);
      return;
    }
    const root = rootRef.current;
    const rect = root?.getBoundingClientRect();
    const query = match[2] ?? '';
    onMentionChange({
      query,
      start: cursor - query.length - 1,
      end: cursor,
      left: rect ? rect.left + 12 : 0,
      top: rect ? Math.min(rect.bottom - 4, window.innerHeight - 220) : 0,
    });
  };

  const applyTextChange = (nextValue: string, nextSelection: TextRange) => {
    valueRef.current = nextValue;
    lastSelectionRef.current = nextSelection;
    pendingSelectionRef.current = nextSelection;
    onChange(nextValue);
    refreshMention(nextValue, nextSelection.end);
  };

  const insertText = (text: string, range?: TextRange) => {
    const currentRange = range ?? getCurrentSelectionRange(rootRef.current) ?? lastSelectionRef.current;
    const start = Math.max(0, Math.min(currentRange.start, currentRange.end, valueRef.current.length));
    const end = Math.max(0, Math.min(Math.max(currentRange.start, currentRange.end), valueRef.current.length));
    const nextValue = `${valueRef.current.slice(0, start)}${text}${valueRef.current.slice(end)}`;
    const cursor = start + text.length;
    applyTextChange(nextValue, { start: cursor, end: cursor });
  };

  useImperativeHandle(ref, () => ({
    focus: () => rootRef.current?.focus(),
    getBoundingClientRect: () => rootRef.current?.getBoundingClientRect() ?? null,
    getSelectionRange: () => getCurrentSelectionRange(rootRef.current) ?? lastSelectionRef.current,
    insertText,
    setSelectionRange: (start: number, end: number) => {
      const nextSelection = { start, end };
      lastSelectionRef.current = nextSelection;
      pendingSelectionRef.current = nextSelection;
      if (rootRef.current) setEditableSelection(rootRef.current, nextSelection);
    },
  }));

  const syncFromDom = () => {
    const root = rootRef.current;
    if (!root) return;
    const nextValue = readPlainText(root);
    const nextSelection = getCurrentSelectionRange(root) ?? { start: nextValue.length, end: nextValue.length };
    applyTextChange(nextValue, nextSelection);
  };

  const refreshCurrentMention = () => {
    const selection = getCurrentSelectionRange(rootRef.current);
    if (!selection) return;
    lastSelectionRef.current = selection;
    refreshMention(valueRef.current, selection.end);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      onMentionChange?.(null);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    insertText('\n');
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    insertText(text);
  };

  const handleMouseOver = (event: ReactMouseEvent<HTMLDivElement>) => {
    const tokenElement = tokenElementFromEvent(rootRef.current, event.target);
    const token = tokenElement?.dataset.referencePromptToken;
    if (!token || hoveredTokenRef.current === token) return;
    hoveredTokenRef.current = token;
    onTokenMouseEnter?.(token, event);
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const tokenElement = tokenElementFromEvent(rootRef.current, event.target);
    const token = tokenElement?.dataset.referencePromptToken;
    if (!token) return;
    onTokenMouseMove?.(token, event);
  };

  const handleMouseOut = (event: ReactMouseEvent<HTMLDivElement>) => {
    const tokenElement = tokenElementFromEvent(rootRef.current, event.target);
    const token = tokenElement?.dataset.referencePromptToken;
    if (!token) return;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && tokenElement?.contains(relatedTarget)) return;
    if (hoveredTokenRef.current === token) hoveredTokenRef.current = null;
    onTokenMouseLeave?.(token, event);
  };

  return (
    <div
      ref={rootRef}
      role="textbox"
      aria-label={ariaLabel ?? placeholder}
      aria-multiline="true"
      className={`reference-prompt-editor whitespace-pre-wrap break-words ${className}`}
      contentEditable
      data-placeholder={placeholder ?? ''}
      onInput={syncFromDom}
      onKeyDown={handleKeyDown}
      onKeyUp={refreshCurrentMention}
      onMouseMove={handleMouseMove}
      onMouseOut={handleMouseOut}
      onMouseOver={handleMouseOver}
      onMouseUp={refreshCurrentMention}
      onPaste={handlePaste}
      spellCheck
      suppressContentEditableWarning
      tabIndex={0}
    />
  );
});

function renderPromptHtml({
  value,
  tokenMeta,
}: Pick<Props, 'value' | 'tokenMeta'>): string {
  let html = '';
  let lastIndex = 0;
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    const tokenText = match[0];
    const token = match[1];
    const index = match.index ?? 0;
    if (!token) continue;
    if (index > lastIndex) html += escapeHtml(value.slice(lastIndex, index));
    const meta = tokenMeta?.(token);
    const title = meta?.title ? ` title="${escapeAttribute(meta.title)}"` : '';
    html += `<span class="${escapeAttribute(tokenClassName(meta))}" data-reference-prompt-token="${escapeAttribute(token)}"${title}>${escapeHtml(tokenText)}</span>`;
    lastIndex = index + tokenText.length;
  }
  if (lastIndex < value.length) html += escapeHtml(value.slice(lastIndex));
  return html;
}

function tokenClassName(meta: ReferencePromptTokenMeta | null | undefined): string {
  const tone = meta?.tone ?? (meta?.valid === false ? 'invalid' : meta?.valid ? 'valid' : 'neutral');
  const base = 'inline rounded-full border px-1.5 py-[1px] font-medium leading-[1.35] transition-colors';
  if (tone === 'valid') return `${base} border-emerald-400/40 bg-emerald-500/10 text-emerald-200`;
  if (tone === 'invalid') return `${base} border-amber-400/45 bg-amber-500/10 text-amber-200`;
  return `${base} border-brand-300/35 bg-brand-500/10 text-brand-200`;
}

function readPlainText(root: Node): string {
  let text = '';
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }
    if (node instanceof HTMLElement && node.dataset.referencePromptPlaceholder === 'true') return;
    if (node instanceof HTMLBRElement) {
      text += '\n';
      return;
    }
    const isBlock = node instanceof HTMLElement && node !== root && (node.tagName === 'DIV' || node.tagName === 'P');
    if (isBlock && text && !text.endsWith('\n')) text += '\n';
    node.childNodes.forEach(visit);
    if (isBlock && !text.endsWith('\n')) text += '\n';
  };
  root.childNodes.forEach(visit);
  return text;
}

function getCurrentSelectionRange(root: HTMLDivElement | null): TextRange | null {
  if (!root) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!containsNode(root, range.startContainer) || !containsNode(root, range.endContainer)) return null;
  return {
    start: readTextUntil(root, range.startContainer, range.startOffset).length,
    end: readTextUntil(root, range.endContainer, range.endOffset).length,
  };
}

function readTextUntil(root: HTMLDivElement, node: Node, offset: number): string {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return readPlainText(range.cloneContents());
}

function setEditableSelection(root: HTMLDivElement, selectionRange: TextRange) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const startPosition = positionAtOffset(root, selectionRange.start);
  const endPosition = positionAtOffset(root, selectionRange.end);
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function positionAtOffset(root: HTMLDivElement, offset: number): { node: Node; offset: number } {
  let remaining = Math.max(0, offset);
  const visit = (node: Node): { node: Node; offset: number } | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
      return null;
    }
    if (node instanceof HTMLElement && node.dataset.referencePromptPlaceholder === 'true') return null;
    if (node instanceof HTMLBRElement) {
      const parent = node.parentNode ?? root;
      const index = Array.prototype.indexOf.call(parent.childNodes, node);
      if (remaining <= 1) return { node: parent, offset: index + (remaining > 0 ? 1 : 0) };
      remaining -= 1;
      return null;
    }
    for (const child of Array.from(node.childNodes)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(root) ?? { node: root, offset: root.childNodes.length };
}

function containsNode(root: Node, node: Node): boolean {
  return root === node || root.contains(node);
}

function clampSelection(selectionRange: TextRange, maxLength: number): TextRange {
  return {
    start: Math.max(0, Math.min(selectionRange.start, maxLength)),
    end: Math.max(0, Math.min(selectionRange.end, maxLength)),
  };
}

function tokenElementFromEvent(root: HTMLDivElement | null, target: EventTarget | null): HTMLElement | null {
  if (!root || !(target instanceof Element)) return null;
  const tokenElement = target.closest<HTMLElement>('[data-reference-prompt-token]');
  return tokenElement && root.contains(tokenElement) ? tokenElement : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
