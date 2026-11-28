// Data's look, as the Git window's (plugins/shared/git/DESIGN.md): its
// tokens (CSS variables built on the window's theme, so every theme, light
// or dark, gets them) and its patterns as class strings. Views compose
// these rather than spelling out sizes and states again. Tailwind reads
// class names from this file as it is, so each is written out in full.
//
// The scale: 13px text (12px meta, 11px labels), 32px rows (28px in the
// tree's inner levels and the grid), 44px headers that line up across the
// window, 28px controls, 16px icons (14px in dense rows).

import { useEffect } from 'react';
import { styles } from '@hyperpane/ui';

export const DATA_TOKENS_CSS = `
:root {
  /* Surfaces: the window is --node-bg; the Explorer's a step off it; a card
     or a raised field a step more. Lines are hairlines, used sparingly. */
  --data-rail: color-mix(in srgb, var(--node-fg) 3%, var(--node-bg));
  --data-raised: color-mix(in srgb, var(--node-fg) 4%, var(--node-bg));
  --data-line: color-mix(in srgb, var(--node-fg) 8%, transparent);
  --data-line-strong: color-mix(in srgb, var(--node-fg) 13%, transparent);

  /* Fills: a quiet control's rest, hover and press. */
  --data-fill: color-mix(in srgb, var(--node-fg) 6%, transparent);
  --data-fill-hover: color-mix(in srgb, var(--node-fg) 10%, transparent);
  --data-fill-active: color-mix(in srgb, var(--node-fg) 14%, transparent);

  /* Picked: a soft pill in the accent; quieter where the list hasn't the keys. */
  --data-selected: color-mix(in srgb, var(--node-accent) 16%, transparent);
  --data-selected-hover: color-mix(in srgb, var(--node-accent) 22%, transparent);
  --data-selected-quiet: color-mix(in srgb, var(--node-fg) 8%, transparent);

  /* The grid: a row's hover, picked cells, a changed, new or deleted row. */
  --data-row-hover: color-mix(in srgb, var(--node-fg) 3%, transparent);
  --data-cell-picked: color-mix(in srgb, var(--node-accent) 16%, transparent);
  --data-cell-edge: color-mix(in srgb, var(--node-accent) 60%, transparent);

  /* States, one colour each. */
  --data-ok: var(--ansi-2);
  --data-warn: var(--ansi-3);
  --data-error: var(--ansi-1);
  --data-key: var(--ansi-3);
}
`;

let styled = false;
/** Adds the tokens, once per frame. */
export function useDataStyles() {
  useEffect(() => {
    if (styled) return;
    styled = true;
    const tag = document.createElement('style');
    tag.dataset.data = '';
    tag.textContent = DATA_TOKENS_CSS;
    document.head.append(tag);
  }, []);
}

/** Type: 13px body, 12px small, 11px labels (uppercase, sparingly). */
export const text = {
  base: 'text-[13px] leading-5',
  small: 'text-xs leading-4',
  label: 'text-[11px] leading-4 font-medium uppercase tracking-[0.06em] text-[var(--node-muted)]',
  muted: 'text-[var(--node-muted)]',
  mono: 'font-mono text-xs',
} as const;

/** A row in a list or the tree: 32px (28px compact), 8px corners. */
export const row = {
  base: 'group/row relative flex h-8 min-w-0 cursor-default items-center gap-2 rounded-control px-2 text-[13px] outline-none transition-colors duration-100 touch:h-11',
  compact: 'group/row relative flex h-7 min-w-0 cursor-default items-center gap-2 rounded-control px-2 text-[13px] outline-none transition-colors duration-100 touch:h-10',
  hover: 'hover:bg-[var(--node-hover)]',
  /** Picked: a soft pill in the accent; quieter while the list hasn't the keys. */
  selected:
    'bg-[var(--data-selected-quiet)] group-focus-within/list:bg-[var(--data-selected)] group-focus-within/list:hover:bg-[var(--data-selected-hover)]',
  /** A list's inset: rows sit 6px in from its edges. */
  list: 'px-1.5 py-1',
} as const;

/** A section's header: a small uppercase label, its count, actions at the
 * end; 28px, no line under it. */
export const section = {
  header: 'flex h-7 min-w-0 items-center gap-1.5 px-2.5 text-[11px] leading-4 font-medium uppercase tracking-[0.06em] text-[var(--node-muted)]',
  count: 'font-normal tracking-normal tabular-nums opacity-75',
} as const;

/** A pane's header: 44px, so lines meet across the window; a hairline under it. */
export const header = {
  base: 'flex h-11 min-w-0 flex-none items-center gap-1.5 border-b border-[var(--data-line)] px-2 touch:h-12',
  title: 'min-w-0 truncate text-[13px] font-medium',
  meta: 'min-w-0 truncate text-xs text-[var(--node-muted)] tabular-nums',
} as const;

/** A view's foot (how many, how long): 32px, 12px muted, a hairline over it. */
export const footer =
  'scrollbar-none flex h-8 min-w-0 flex-none items-center gap-3 overflow-x-auto border-t border-[var(--data-line)] px-3 text-xs text-[var(--node-muted)] tabular-nums whitespace-nowrap touch:h-10';

/** A chip: a small tinted pill. Its colour comes from `--chip`. */
export const chip = {
  base: 'inline-flex h-5 flex-none items-center gap-1 rounded-full px-2 text-[11px] leading-none font-medium tabular-nums whitespace-nowrap',
  tinted: 'bg-[color-mix(in_srgb,var(--chip,var(--node-fg))_14%,transparent)] text-[var(--chip,var(--node-muted))]',
  neutral: 'bg-[var(--data-fill)] text-[var(--node-muted)]',
} as const;

const buttonBase = [
  'inline-flex h-7 flex-none items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition-[background-color,color,filter,scale] duration-100 active:scale-[0.98] disabled:cursor-default disabled:opacity-50 touch:h-9 [&_svg]:size-4 [&_svg]:flex-none',
  styles.focusRing,
].join(' ');

/** Buttons: primary (the accent, one per place), secondary (a soft fill),
 * ghost (nothing until hovered), danger. 28px; `lg` 32px. */
export const button = {
  base: buttonBase,
  lg: 'h-8 px-3.5',
  icon: 'w-7 px-0 touch:w-9',
  /** Disabled, it greys to a quiet fill rather than a dim accent. */
  primary:
    'bg-[var(--node-accent)] text-white hover:brightness-110 active:brightness-95 disabled:bg-[var(--data-fill)] disabled:text-[var(--node-muted)] disabled:shadow-none disabled:opacity-100',
  secondary: 'bg-[var(--data-fill)] text-[var(--node-fg)] hover:bg-[var(--data-fill-hover)] active:bg-[var(--data-fill-active)]',
  ghost: 'text-[var(--node-muted)] hover:bg-[var(--node-hover)] hover:text-[var(--node-fg)] active:bg-[var(--node-active)]',
  danger: 'bg-[color-mix(in_srgb,var(--data-error)_14%,transparent)] text-[var(--data-error)] hover:bg-[color-mix(in_srgb,var(--data-error)_22%,transparent)]',
} as const;

/** A field: 28px (`lg` 32px in a form), a soft fill, the accent's ring while it has the keys. */
export const field =
  'h-7 min-w-0 rounded-full bg-[var(--data-fill)] px-2.5 text-[13px] text-[var(--node-fg)] outline-none placeholder:text-[var(--node-muted)] transition-[background-color,box-shadow] duration-100 hover:bg-[var(--data-fill-hover)] focus:bg-transparent focus:shadow-[0_0_0_1.5px_var(--node-accent)] touch:h-9';

/** A card: a raised surface (a fill, no line), 10px corners. Data's own
 * step off the window rather than the kit's raised surface, which a light
 * theme draws in the window's own white, so the card would vanish. */
export const card = 'rounded-card bg-[var(--data-raised)]';

/** A key's hint (⌘↵) in a button: small, in the text's colour, faded. */
export const kbd = 'font-sans text-[11px] font-medium tracking-wide opacity-70';
