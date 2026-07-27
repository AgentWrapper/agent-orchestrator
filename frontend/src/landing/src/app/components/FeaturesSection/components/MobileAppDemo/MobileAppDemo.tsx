import Image from "next/image";

export function MobileAppDemo() {
  return (
    <div className="flex h-[280px] w-full items-center justify-center sm:h-[360px] lg:h-[390px]">
      <Image
        src="/changelog/mobile-agents.png"
        alt="The AO mobile app showing connected agent sessions grouped by needs you, working, and done"
        width={1022}
        height={1982}
        sizes="(max-width: 640px) 240px, 320px"
        className="h-full w-auto object-contain drop-shadow-[0_24px_48px_rgba(0,0,0,0.45)]"
      />
    </div>
  );
}
