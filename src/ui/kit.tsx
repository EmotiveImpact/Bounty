// Bounty's building blocks: one small set of pieces every screen is built
// from, so each screen opens on one answer and keeps its depth a tap away.
// Behaviour (focus, keyboard, Escape, screen readers) comes from Radix
// Primitives; the look comes from kit.css. See the Blocks page (#Blocks).
import React, { createContext, useCallback, useContext, useState } from "react";
import { Dialog, DropdownMenu, Progress, Tabs as RTabs, Toast, ToggleGroup } from "radix-ui";
import "./kit.css";

export type Tint =
  | "lime"
  | "sky"
  | "periwinkle"
  | "peach"
  | "candy"
  | "pistachio"
  | "butter"
  | "lemon"
  | "lilac";
const tintVar = (t?: Tint) =>
  t ? ({ "--k-tint": `var(--k-${t})` } as React.CSSProperties) : undefined;

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* Buttons. One "main" (black) button per card or window, for the likely
   next step. "tab" uses the page colour for a positive extra. */
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "main" | "tab" | "line" | "text";
  size?: "sm";
  tint?: Tint;
};
export const Button = React.forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = "line", size, tint, className, style, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("k-btn", variant, size, className)}
      style={{ ...tintVar(tint), ...style }}
      {...rest}
    />
  );
});

export type ChipTone =
  | "plan"
  | "bought"
  | "listed"
  | "wait"
  | "paid"
  | "done"
  | "sample"
  | "buy"
  | "think"
  | "leave";
/** Where something is up to. Same words and colours on every screen. */
export function Chip({ tone, children, dot = true }: { tone: ChipTone; children: React.ReactNode; dot?: boolean }) {
  const dotted = dot && !["sample", "buy", "think", "leave"].includes(tone);
  return <span className={cx("k-chip", tone, dotted && "dot")}>{children}</span>;
}

/** The tab colour block at the top of a page. */
export function PageHead({
  title,
  lead,
  tint,
  aside,
}: {
  title: string;
  lead: React.ReactNode;
  tint?: Tint;
  aside?: React.ReactNode;
}) {
  return (
    <header className="k-head" style={tintVar(tint)}>
      <div>
        <h1 className="k-display">{title}</h1>
        <p>{lead}</p>
      </div>
      {aside}
    </header>
  );
}

/** Up to four figures that sum up a page. */
export function Figures({ children }: { children: React.ReactNode }) {
  return <div className="k-figs">{children}</div>;
}
export function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  tone?: "profit" | "loss";
}) {
  return (
    <div className={cx("k-fig", tone)}>
      <small>{label}</small>
      <b className="k-display">{value}</b>
      {note && <span>{note}</span>}
    </div>
  );
}

export function Card({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <section className={cx("k-card", className)} style={style}>
      {children}
    </section>
  );
}

/** One line in a list: a trip, a tip, a sale, a source. The whole row
    opens its window when it has onClick. */
export function Row({
  badge,
  date,
  tint,
  title,
  sub,
  value,
  valueNote,
  tone,
  onClick,
  slot,
}: {
  badge?: React.ReactNode;
  /** Show the badge as a little calendar date, like 2 NOV. */
  date?: { day: string; month: string };
  tint?: Tint;
  title: React.ReactNode;
  sub?: React.ReactNode;
  value?: React.ReactNode;
  valueNote?: React.ReactNode;
  tone?: "profit";
  onClick?: () => void;
  slot?: React.ReactNode;
}) {
  const inner = (
    <>
      {date ? (
        <span className="k-badge k-cal" style={tintVar(tint)}>
          {date.day}
          <small>{date.month}</small>
        </span>
      ) : badge !== undefined ? (
        <span className="k-badge" style={tintVar(tint)}>
          {badge}
        </span>
      ) : (
        <span />
      )}
      <span className="k-rt">
        <b>{title}</b>
        {sub && <small>{sub}</small>}
      </span>
      {value !== undefined ? (
        <span className={cx("k-rv", tone)}>
          <b>{value}</b>
          {valueNote && <small>{valueNote}</small>}
        </span>
      ) : (
        <span />
      )}
      {slot ? (
        <span className="k-slot">{slot}</span>
      ) : onClick ? (
        <svg className="k-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span />
      )}
    </>
  );
  return onClick && !slot ? (
    <button type="button" className="k-row" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="k-row">{inner}</div>
  );
}
export function Rows({ children }: { children: React.ReactNode }) {
  return <div className="k-rows">{children}</div>;
}

/** A bar for cash, carry, units sold or the HMRC guide. Red when over. */
export function Meter({
  label,
  value,
  max,
  shown,
  over,
  ink,
}: {
  label: React.ReactNode;
  value: number;
  max: number;
  shown?: React.ReactNode;
  over?: boolean;
  ink?: boolean;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cx("k-meter", over && "over", ink && "ink")}>
      <div className="k-mtop">
        <span>{label}</span>
        {shown !== undefined && <b>{shown}</b>}
      </div>
      <Progress.Root className="k-track" value={Math.min(value, max)} max={max || 1}>
        <Progress.Indicator style={{ transform: `scaleX(${pct / 100})` }} />
      </Progress.Root>
    </div>
  );
}

/** A labelled field: label above, hint below, error in red plain words. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx("k-field", !!error && "bad")}>
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="k-lab">{label}</span>}
      {children}
      {error ? (
        <p className="k-err" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="k-hint">{hint}</p>
      )}
    </div>
  );
}
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx("k-input", className)} {...rest} />;
  },
);
/** A pounds field with the £ shown inside. */
export const MoneyInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function MoneyInput(props, ref) {
    return (
      <div className="k-money">
        <span aria-hidden="true">£</span>
        <input ref={ref} className="k-input" type="text" inputMode="decimal" autoComplete="off" {...props} />
      </div>
    );
  },
);
export function Select({ className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("k-input", className)} {...rest} />;
}

/** Pick one of a few, like Car, Bus or Walk. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
  label: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      className="k-seg"
      value={value}
      aria-label={label}
      onValueChange={(v) => v && onChange(v as T)}
    >
      {options.map(([v, l]) => (
        <ToggleGroup.Item key={v} value={v}>
          {l}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/** Pill tabs, like Open and Finished. */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: string; count?: number; content: React.ReactNode }[];
  label: string;
}) {
  return (
    <RTabs.Root value={value} onValueChange={(v) => onChange(v as T)} style={{ display: "grid", gap: 16 }}>
      <RTabs.List className="k-tabs" aria-label={label}>
        {tabs.map((t) => (
          <RTabs.Trigger key={t.value} value={t.value}>
            {t.label}
            {t.count !== undefined && <em>{t.count}</em>}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {tabs.map((t) => (
        <RTabs.Content key={t.value} value={t.value} style={{ outline: "none" }}>
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

/** A window for a task or the full detail behind a card. Centred on a
    computer, rising from the bottom on a phone. The footer holds the one
    main button. */
export function Window({
  open,
  onOpenChange,
  title,
  description,
  tint,
  wide,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  tint?: Tint;
  wide?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="k-overlay" />
        <Dialog.Content
          className={cx("k-window", wide && "wide")}
          style={tintVar(tint)}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="k-whead">
            <span className="k-grab" aria-hidden="true" />
            <Dialog.Title className="k-display">{title}</Dialog.Title>
            {description && <Dialog.Description>{description}</Dialog.Description>}
            <Dialog.Close className="k-wclose" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 3.5l9 9m0-9-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </Dialog.Close>
          </div>
          <div className="k-wbody">{children}</div>
          {footer && <div className="k-wfoot">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export type MenuItem = { label: string; onSelect: () => void; tone?: "loss" } | "-";
/** Everything that is not the main step: More. */
export function Menu({ items, label = "More", size }: { items: MenuItem[]; label?: string; size?: "sm" }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="line" size={size}>
          {label}
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ width: 14, height: 14 }}>
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="k-menu" align="start" sideOffset={6} collisionPadding={12}>
          {items.map((it, i) =>
            it === "-" ? (
              <DropdownMenu.Separator key={i} />
            ) : (
              <DropdownMenu.Item key={i} className={it.tone} onSelect={it.onSelect}>
                {it.label}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

type ToastMsg = { id: number; text: string; undo?: () => void };
const ToastCtx = createContext<(text: string, undo?: () => void) => void>(() => undefined);
/** Wrap a screen in this, then call useToast()("Sale recorded.", undo). */
export function Toasts({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<ToastMsg[]>([]);
  const say = useCallback((text: string, undo?: () => void) => {
    setList((l) => [...l.slice(-2), { id: Date.now() + Math.random(), text, undo }]);
  }, []);
  return (
    <ToastCtx.Provider value={say}>
      <Toast.Provider swipeDirection="down" duration={5000} label="Notification">
        {children}
        {list.map((t) => (
          <Toast.Root
            key={t.id}
            className="k-toast"
            onOpenChange={(o) => !o && setList((l) => l.filter((x) => x.id !== t.id))}
          >
            <Toast.Description>{t.text}</Toast.Description>
            {t.undo && (
              <Toast.Action altText="Undo" onClick={t.undo}>
                Undo
              </Toast.Action>
            )}
          </Toast.Root>
        ))}
        <Toast.Viewport className="k-toasts" />
      </Toast.Provider>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Grey for sample data, amber for "check before you go". */
export function Notice({
  tone,
  title,
  children,
}: {
  tone?: "warn" | "loss" | "profit";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx("k-note", tone)} role={tone === "loss" ? "alert" : undefined}>
      {title && <b>{title}</b>}
      <span>{children}</span>
    </div>
  );
}

/** What will appear here, and the one step to get there. */
export function Empty({ title, text, action }: { title: string; text: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="k-empty">
      <h3 className="k-display">{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

/** The one answer a screen gives: Buy, Think or Leave. */
export function Answer({
  verdict,
  headline,
  why,
  facts,
  children,
}: {
  verdict: "buy" | "think" | "leave";
  headline?: React.ReactNode;
  why: React.ReactNode;
  facts?: [string, React.ReactNode][];
  children?: React.ReactNode;
}) {
  const word = { buy: "Buy", think: "Think", leave: "Leave" }[verdict];
  return (
    <section className={cx("k-answer", verdict)}>
      <div className="k-atop">
        <span className="k-word k-display">{word}</span>
        {headline && <span className="k-ahead">{headline}</span>}
      </div>
      <p>{why}</p>
      {facts && (
        <div className="k-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <small>{k}</small>
              <b>{v}</b>
            </div>
          ))}
        </div>
      )}
      {children}
    </section>
  );
}
