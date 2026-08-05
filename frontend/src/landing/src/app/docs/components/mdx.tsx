import Link from "next/link";
import { isValidElement, type ReactNode } from "react";
import { DownloadButton } from "@/app/components/DownloadButton";
import { slugify } from "@/lib/content-utils";
import { Tab, Tabs } from "./DocsTabs";

// Text of a heading's children, so ids match the TOC's slugify(headingText).
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function Heading({ level, children }: { level: 2 | 3 | 4; children: ReactNode }) {
  const id = slugify(textOf(children));
  if (level === 2) return <h2 id={id}>{children}</h2>;
  if (level === 3) return <h3 id={id}>{children}</h3>;
  return <h4 id={id}>{children}</h4>;
}

// Brands with a real asset under /public/docs/logos/ (others fall back to a monogram).
const FILE_LOGOS: Record<string, string> = {
  aider: "aider.png",
  "claude-code": "claude-code.svg",
  claude: "claude-code.svg",
  codex: "codex.svg",
  cursor: "cursor.svg",
  opencode: "opencode.svg",
};

export function Logo({ name, size = 20, className }: { name: string; size?: number; className?: string }) {
  const key = name.toLowerCase();
  const file = FILE_LOGOS[key];
  if (file) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/docs/logos/${file}`}
        alt=""
        aria-hidden="true"
        className={className}
        style={{ width: size, height: size, flexShrink: 0, objectFit: "contain" }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{ width: size, height: size }}
      // biome-ignore lint/style/useNamingConvention: inline style keys
    >
      <span className="grid size-full place-items-center rounded-sm bg-surface text-[0.6em] font-bold uppercase text-foreground">
        {name.charAt(0)}
      </span>
    </span>
  );
}

const CALLOUT_TONE: Record<string, string> = {
  info: "border-border bg-muted/35",
  warn: "border-border bg-muted/35",
  warning: "border-border bg-muted/35",
  error: "border-border bg-muted/35",
};

export function Callout({ type = "info", title, children }: { type?: string; title?: ReactNode; children: ReactNode }) {
  return (
    <div className={`my-6 rounded-xl border px-4 py-3 ${CALLOUT_TONE[type] ?? CALLOUT_TONE.info}`}>
      {title && <div className="mb-1 text-sm font-semibold text-foreground">{title}</div>}
      <div className="text-sm text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{children}</div>
    </div>
  );
}

export function Accordions({ children }: { children: ReactNode }) {
  return <div className="my-6 space-y-2">{children}</div>;
}

export function Accordion({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-border bg-muted/30 px-4 py-3">
      <summary className="cursor-pointer list-none text-sm font-medium text-foreground marker:hidden">
        {title}
      </summary>
      <div className="mt-3 text-sm text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{children}</div>
    </details>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return (
    <div className="my-6 ml-3 border-l border-border/80 pl-6 [counter-reset:step] [&>*]:relative [&>*]:mb-6 [&>*]:before:absolute [&>*]:before:-left-[2.1rem] [&>*]:before:grid [&>*]:before:size-6 [&>*]:before:place-items-center [&>*]:before:rounded-full [&>*]:before:border [&>*]:before:border-border [&>*]:before:bg-background [&>*]:before:text-xs [&>*]:before:text-muted-foreground [&>*]:before:[counter-increment:step] [&>*]:before:[content:counter(step)]">
      {children}
    </div>
  );
}

export function Step({ children }: { children: ReactNode }) {
  return <div className="[&>*:first-child]:mt-0">{children}</div>;
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="my-6 grid gap-3 sm:grid-cols-2">{children}</div>;
}

export function Card({
  title,
  href,
  description,
  children,
}: {
  title: string;
  href?: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description ?? children}</div>
    </>
  );
  const cls =
    "block rounded-xl border border-border bg-muted/30 p-4 no-underline transition-colors hover:bg-muted/45";
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function PluginGrid({ children }: { children: ReactNode }) {
  return (
    <div className="my-6 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">{children}</div>
  );
}

export function PluginCard({
  name,
  logo,
  href,
  description,
  badge,
}: {
  name: string;
  logo: string;
  href: string;
  description: string;
  badge?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3.5 rounded-xl border border-border bg-muted/30 p-4 no-underline transition-colors hover:bg-muted/45"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background">
        <Logo name={logo} size={22} />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="inline-flex items-center gap-2 text-[0.9375rem] font-semibold text-foreground">
          {name}
          {badge}
        </span>
        <span className="text-[0.8125rem] leading-normal text-muted-foreground">{description}</span>
      </span>
    </Link>
  );
}

type Status = "full" | "partial" | "none";
const STATUS_LABEL: Record<Status, string> = { full: "Supported", partial: "Limited", none: "Not supported" };
const STATUS_DOT: Record<Status, string> = { full: "bg-green-400", partial: "bg-amber-400", none: "bg-muted-foreground" };

function PlatformCell({ platform, status }: { platform: "macos" | "linux" | "windows"; status: Status }) {
  const logoName = platform === "macos" ? "apple" : platform;
  const title = platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
      <Logo name={logoName} size={18} />
      <div className="flex min-w-0 flex-col">
        <span className="text-[0.8125rem] font-semibold text-foreground">{title}</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`inline-block size-1.5 rounded-full ${STATUS_DOT[status]}`} />
          {STATUS_LABEL[status]}
        </span>
      </div>
    </div>
  );
}

export function PlatformSupport({
  macos = "full",
  linux = "full",
  windows = "full",
  note,
}: {
  macos?: Status;
  linux?: Status;
  windows?: Status;
  note?: ReactNode;
}) {
  return (
    <div className="my-5">
      <div className="flex flex-wrap gap-2">
        <PlatformCell platform="macos" status={macos} />
        <PlatformCell platform="linux" status={linux} />
        <PlatformCell platform="windows" status={windows} />
      </div>
      {note && <p className="mt-2 text-[0.8125rem] text-muted-foreground">{note}</p>}
    </div>
  );
}

const RELEASES_URL = "https://github.com/Untrivial-ai/agent-orchestrator/releases";

export function InstallDownloads() {
  return (
    <div className="my-6 rounded-xl border border-border bg-muted/30 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-foreground">Get Agent Orchestrator</div>
        <a href={RELEASES_URL} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
          View releases →
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <DownloadButton size="md" className="rounded-xl" />
        <span className="text-sm text-muted-foreground">macOS · Linux · Windows</span>
      </div>
    </div>
  );
}

// Passed to <MDXRemote components={...}>. Keys must match the JSX tags in the MDX.
export const docsMdxComponents = {
  h2: ({ children }: { children: ReactNode }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }: { children: ReactNode }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }: { children: ReactNode }) => <Heading level={4}>{children}</Heading>,
  Logo,
  Callout,
  Accordion,
  Accordions,
  Step,
  Steps,
  Tab,
  Tabs,
  Card,
  Cards,
  PluginCard,
  PluginGrid,
  PlatformSupport,
  InstallDownloads,
};
