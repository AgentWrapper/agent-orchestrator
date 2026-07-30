export function AOLogo() {
  return (
    <span
      aria-label="Agent Orchestrator"
      className="inline-flex items-center gap-2 font-sans text-base font-medium leading-none tracking-[-0.5px] text-foreground"
    >
      <img
        src="/ao-logo.svg"
        alt=""
        width={20}
        height={20}
        aria-hidden="true"
        className="size-5 shrink-0"
      />
      <span>Agent Orchestrator</span>
    </span>
  );
}
