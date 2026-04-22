import * as Tabs from "@radix-ui/react-tabs";
import { Trash2 } from "lucide-react";
import React from "react";
import { twMerge } from "tailwind-merge";
import type { CodexSessionMessage, CodexSessionSummary } from "../../shared/shimeji-api";

export function SettingsTab(props: { readonly value: string; readonly icon: React.ReactNode; readonly label: string }): React.JSX.Element {
  return (
    <Tabs.Trigger
      value={props.value}
      className="inline-flex items-center justify-center gap-2 rounded-[6px] px-3 text-slate-600 outline-none transition hover:text-slate-950 data-[state=active]:bg-white data-[state=active]:text-slate-950 data-[state=active]:shadow-sm"
    >
      {props.icon}
      <span>{props.label}</span>
    </Tabs.Trigger>
  );
}

export function SectionCard(props: {
  readonly title: string;
  readonly action?: React.ReactNode;
  readonly className?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={twMerge("flex h-full flex-col rounded-lg border border-slate-200 bg-white p-5 shadow-sm", props.className)}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold tracking-normal text-slate-950">{props.title}</h2>
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: "primary" | "secondary" | "danger" }): React.JSX.Element {
  const { className, variant = "primary", ...buttonProps } = props;
  return (
    <button
      {...buttonProps}
      className={twMerge(
        "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium shadow-sm outline-none transition focus:ring-4 disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" && "bg-slate-950 text-white hover:bg-slate-800 focus:ring-slate-200",
        variant === "secondary" && "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-200",
        variant === "danger" && "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 focus:ring-red-100",
        className,
      )}
    />
  );
}

export function modeButtonClass(active: boolean): string {
  return twMerge(
    "h-8 w-full rounded-[6px] px-3 text-sm font-medium text-slate-600 outline-none transition hover:text-slate-950 focus:ring-4 focus:ring-slate-200 disabled:pointer-events-none disabled:opacity-50",
    active && "bg-white text-slate-950 shadow-sm",
  );
}

export function ModeTooltip(props: { readonly id: string; readonly text: string }): React.JSX.Element {
  return (
    <span
      id={props.id}
      role="tooltip"
      className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-max max-w-64 -translate-x-1/2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-700 opacity-0 shadow-md transition group-hover:opacity-100 group-focus-within:opacity-100"
    >
      {props.text}
    </span>
  );
}

export function StatusBox(props: { readonly text: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700" aria-live="polite">
      {props.text}
    </div>
  );
}

export function SessionList(props: {
  readonly sessions: readonly CodexSessionSummary[];
  readonly selectedSessionId: string | undefined;
  readonly loading: boolean;
  readonly busyAction: string | undefined;
  readonly onSelect: (sessionId: string) => void;
  readonly onDelete: (sessionId: string) => void;
}): React.JSX.Element {
  if (props.loading) {
    return <EmptyState>세션을 불러오는 중이에요.</EmptyState>;
  }

  if (props.sessions.length === 0) {
    return <EmptyState>저장된 Codex 세션을 찾지 못했어요.</EmptyState>;
  }

  return (
    <div className="min-h-0 space-y-2 overflow-auto pr-1">
      {props.sessions.map((session) => (
        <article
          key={session.id}
          className={twMerge(
            "rounded-lg border border-slate-200 bg-white p-3 transition",
            props.selectedSessionId === session.id && "border-slate-400 bg-slate-50",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <strong className="text-sm font-semibold text-slate-950">{session.isActive ? "현재 세션" : "Codex 세션"}</strong>
                {session.isActive ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">사용 중</span> : null}
              </div>
              <p className="mt-1 truncate text-xs text-slate-500">{session.id}</p>
              <p className="mt-1 truncate text-xs text-slate-500">{formatSessionDate(session.updatedAt)}</p>
              <p className="mt-1 truncate text-xs text-slate-500">{session.cwd || "작업 폴더 없음"}</p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button
                type="button"
                variant="secondary"
                className="h-8 px-2 text-xs"
                disabled={props.busyAction !== undefined}
                onClick={() => props.onSelect(session.id)}
              >
                사용
              </Button>
              <Button
                type="button"
                variant="danger"
                className="h-8 px-2"
                aria-label="세션 보관"
                disabled={props.busyAction !== undefined}
                onClick={() => props.onDelete(session.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

export function SessionDetail(props: {
  readonly messages: readonly CodexSessionMessage[];
  readonly selectedSessionId: string | undefined;
}): React.JSX.Element {
  if (props.selectedSessionId === undefined) {
    return <EmptyState>세션을 선택하면 여기에 보여줄게요.</EmptyState>;
  }

  if (props.messages.length === 0) {
    return <EmptyState>이 세션에서 보여줄 대화를 찾지 못했어요.</EmptyState>;
  }

  return (
    <div className="min-h-0 space-y-3 overflow-auto pr-1">
      {props.messages.map((message, index) => (
        <article
          key={`${message.timestamp}-${message.role}-${index}`}
          className={twMerge("rounded-lg px-3 py-2 text-sm leading-6", message.role === "user" ? "bg-sky-50 text-sky-950" : "bg-amber-50 text-amber-950")}
        >
          <strong className="mb-1 block text-xs font-semibold">{message.role === "user" ? "User" : "Assistant"}</strong>
          <p className="max-h-32 overflow-auto whitespace-pre-wrap select-text">{message.text}</p>
        </article>
      ))}
    </div>
  );
}

export function EmptyState(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-8 text-center text-sm text-slate-500">{props.children}</p>;
}

function formatSessionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
