// A code editor (CodeMirror, as the Editor has it): SQL with the
// connection's dialect and its tables and columns to complete, JSON, or
// text; ⌘Enter runs (the selection, else the statement at the cursor).

import { useEffect, useRef } from 'react';
import { json } from '@codemirror/lang-json';
import { MySQL, PostgreSQL, SQLite, StandardSQL, type SQLDialect, sql } from '@codemirror/lang-sql';
import { EditorState, type Extension, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { setup } from '@hyperpane/code';
import { cn } from '@hyperpane/ui';

export type Language = 'sql' | 'json' | 'text';

export interface CodeEditorProps {
  value: string;
  onChange?(value: string): void;
  language: Language;
  /** SQL: postgres, mysql, sqlite, or another (standard SQL). */
  dialect?: string;
  /** SQL: tables to complete, with their columns (`schema.table` too). */
  schema?: Record<string, string[]>;
  /** ⌘Enter / Ctrl+Enter: the text to run (the selection, else the
   * statement at the cursor, else all of it). */
  onRun?(text: string): void;
  /** ⌘S. */
  onSave?(): void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  /** Line numbers in the gutter. */
  lineNumbers?: boolean;
  autoFocus?: boolean;
  /** Set to what runs as ⌘Enter does (a Run button's click). */
  handle?: { current: { run(): void; focus(): void } | null };
}

const DIALECTS: Record<string, SQLDialect> = { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite };

/** The statement around `pos`: from the `;` before it to the one after
 * (quotes and comments taken into account). */
export function statementAt(text: string, pos: number): { from: number; to: number; text: string } {
  const bounds: number[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) i += text[i] === '\\' && q !== '"' ? 2 : 1;
      i++;
    } else if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '$' && /^\$[A-Za-z_]*\$/.test(text.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i))![0];
      const end = text.indexOf(tag, i + tag.length);
      i = end < 0 ? text.length : end + tag.length;
    } else {
      if (c === ';') bounds.push(i);
      i++;
    }
  }
  let from = 0;
  let to = text.length;
  for (const b of bounds) {
    if (b < pos) from = b + 1;
    else {
      to = b;
      break;
    }
  }
  // The cursor just after a `;`: the statement it ends.
  if (from > 0 && text.slice(from, pos).trim() === '' && text.slice(from, to).trim() === '') {
    const prev = bounds.filter((b) => b < from - 1).pop();
    to = from - 1;
    from = prev === undefined ? 0 : prev + 1;
  }
  return { from, to, text: text.slice(from, to).trim() };
}

export function CodeEditor(p: CodeEditorProps) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const props = useRef(p);
  props.current = p;

  const run = (v: EditorView) => {
    const sel = v.state.selection.main;
    const doc = v.state.doc.toString();
    const text = !sel.empty ? doc.slice(sel.from, sel.to) : props.current.language === 'sql' ? statementAt(doc, sel.head).text || doc : doc;
    props.current.onRun?.(text);
    return true;
  };
  if (p.handle) p.handle.current = { run: () => void (view.current && run(view.current)), focus: () => view.current?.focus() };

  const language = (): Extension => {
    const { language: l, dialect, schema } = props.current;
    if (l === 'sql') return sql({ dialect: DIALECTS[dialect ?? ''] ?? StandardSQL, schema: schema ?? {}, upperCaseKeywords: true });
    if (l === 'json') return json();
    return [];
  };

  useEffect(() => {
    if (!box.current) return;
    const s = setup(
      {
        save: () => props.current.onSave?.(),
        update: (u) => {
          if (u.docChanged) props.current.onChange?.(u.state.doc.toString());
        },
        toggleWrap: () => {},
      },
      { indent: { unit: '  ', tabSize: 2 }, wrap: p.language !== 'sql', looks: { fontSize: 12, lineNumbers: p.lineNumbers ?? true, activeLine: true } },
    );
    const v = new EditorView({
      parent: box.current,
      state: EditorState.create({
        doc: p.value,
        extensions: [
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run }])),
          ...s.extensions,
          p.placeholder ? placeholderExt(p.placeholder) : [],
          EditorState.readOnly.of(!!p.readOnly),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
        ],
      }),
    });
    view.current = v;
    // setup() has the language's compartment (empty): this connection's goes in it.
    v.dispatch({ effects: s.language.reconfigure(language()) });
    if (p.autoFocus) v.focus();
    (box.current as HTMLDivElement & { _lang?: typeof s.language })._lang = s.language;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  // A value from outside (another window's edit, a tab switched to).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== p.value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.value } });
  }, [p.value]);

  // The schema arriving after the editor.
  const schemaKey = JSON.stringify(p.schema ?? null) + (p.dialect ?? '') + p.language;
  useEffect(() => {
    const v = view.current;
    const lang = (box.current as (HTMLDivElement & { _lang?: { reconfigure(e: Extension): unknown } }) | null)?._lang;
    if (v && lang) v.dispatch({ effects: lang.reconfigure(language()) as never });
  }, [schemaKey]);

  return <div ref={box} className={cn('min-h-0 overflow-hidden text-xs [&_.cm-editor]:h-full [&_.cm-editor]:outline-none', p.className)} />;
}
