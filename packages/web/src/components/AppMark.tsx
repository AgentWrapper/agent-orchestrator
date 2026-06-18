import Image from "next/image";

/**
 * The AO brand mark — the Claude Code mascot recolored blue (the conductor).
 * A small black tile with a faint blue glow; the blue/orange split is the
 * product's identity (blue = the orchestrator / you).
 */
export function AppMark() {
  return (
    <span className="app-mark" aria-hidden="true">
      <Image src="/mascot.png" alt="" width={23} height={23} className="app-mark__img" priority />
    </span>
  );
}
